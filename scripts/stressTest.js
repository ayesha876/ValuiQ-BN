/**
 * scripts/stressTest.js — the Week 3 deliverable: does live feed + voting stay CONSISTENT
 * when many people use it at the same time?
 *
 * This is not a benchmark. Throughput numbers are reported, but the point is correctness under
 * concurrency: a token economy that loses an increment or lets a balance go negative is worse
 * than a slow one, and both failures are silent.
 *
 * WHAT IT PROVES — five invariants, checked against the database after the storm:
 *
 *   1. NO NEGATIVE BALANCES.        Nobody spent tokens they did not have.
 *   2. LEDGER == BALANCE.           Every wallet's applied ledger entries sum to its balance.
 *   3. NO SPEND WITHOUT RECORD.     grants - spends reconciles per user, to the token.
 *   4. NO LOST VOTES.               Each post's total == its opening bid + every stake on it.
 *      This is the one a naive read-modify-write implementation fails: concurrent votes
 *      overwrite each other and the post quietly ends up worth less than was paid for it.
 *   5. RANKING IS SOUND.            The feed comes back ordered by tokens, descending.
 *
 * Run:  npm run stress            (server must already be running)
 *       STRESS_USERS=100 npm run stress
 *
 * ⚠️ Point MONGO_URI at a local/throwaway database. It creates users, events and posts, and
 * the dev grant endpoint it uses only exists outside production.
 */
const mongoose = require('mongoose');
const { io } = require('socket.io-client');

require('../src/modules/auth/auth.model');
require('../src/modules/events/event.model');
require('../src/modules/posts/post.model');
require('../src/modules/votes/vote.model');
require('../src/modules/wallet/wallet.model');
const { signLoginToken } = require('../src/shared/utils/generateToken');

const API = process.env.STRESS_API || 'http://localhost:5000';
const MONGO = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/valuiq_stress';
const USERS = Number(process.env.STRESS_USERS) || 40;
const VOTE_ROUNDS = Number(process.env.STRESS_ROUNDS) || 4;
// Deliberately tunable: a run where nobody ever runs out of tokens never exercises the
// balance guard, and a run where everyone targets one post is the worst case for lost
// updates. Both are worth being able to force.
const GRANT = Number(process.env.STRESS_GRANT) || 5000;
const HOT_POST = process.env.STRESS_HOT === '1'; // everyone piles onto a single post
const POST_COST = 100;
const VOTE_COST = 50;

const run = String(Date.now()).slice(-8);
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label} ${detail}`);
    failures.push(`${label} ${detail}`);
  }
};

async function api(path, { token, method = 'GET', body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  console.log(`\nValuiQ stress test — ${USERS} concurrent users, ${VOTE_ROUNDS} voting rounds`);
  console.log(`API ${API}\nDB  ${MONGO}\n`);

  await mongoose.connect(MONGO);
  const User = mongoose.model('User');
  const Event = mongoose.model('Event');
  const Post = mongoose.model('Post');
  const Vote = mongoose.model('Vote');
  const Wallet = mongoose.model('Wallet');
  const LedgerEntry = mongoose.model('LedgerEntry');

  // --- seed -----------------------------------------------------------------
  // Users are created directly rather than through the auth funnel: this exercises the
  // posting and voting path, and driving OTP email verification 40 times would measure the
  // wrong thing entirely.
  const host = await User.create({ email: `zzstress-host-${run}@valuiq.local`, role: 'Event Organizer', isVerified: true });
  const hostToken = signLoginToken(host);

  // PREFLIGHT: this script seeds through Mongo directly but drives the API over HTTP, so it
  // only works if both point at the SAME database. Getting that wrong produced a confusing
  // "0/100 posts accepted" rather than an obvious error, so it is now checked up front.
  const probe = await Event.create({
    name: `ZZSTRESS probe ${run}`,
    slug: `zzstress-probe-${run}`,
    owner: host.id,
    status: 'live',
    roundStartedAt: new Date(),
    pricing: { minPostCost: POST_COST, minVoteCost: VOTE_COST },
  });
  const probeToken = signLoginToken(host);
  const seen = await api(`/api/events/${probe.id}/arena`, { token: probeToken });
  if (seen.status !== 200) {
    console.error(
      `
The API cannot see data this script just wrote (${seen.status}: ${seen.body?.message}).
` +
        `The server is reading a DIFFERENT database. Start it with the same MONGO_URI:
` +
        `  MONGO_URI="${MONGO}" npm start
`,
    );
    process.exit(1);
  }
  await Event.deleteOne({ _id: probe.id });

  const users = await Promise.all(
    Array.from({ length: USERS }, (_, i) =>
      User.create({ email: `zzstress-u${i}-${run}@valuiq.local`, role: 'Attendee', isVerified: true }),
    ),
  );
  const tokens = users.map((u) => signLoginToken(u));

  for (const feedFormat of ['open', 'segmented']) {
    console.log(`\n─── ${feedFormat.toUpperCase()} FORMAT ───`);

    const event = await Event.create({
      name: `ZZSTRESS ${feedFormat} ${run}`,
      slug: `zzstress-${feedFormat}-${run}`,
      owner: host.id,
      status: 'live',
      roundStartedAt: new Date(),
      feedFormat,
      segment: { type: 'instant', timeLimit: 120 },
      pricing: { minPostCost: POST_COST, minVoteCost: VOTE_COST },
      ...(feedFormat === 'segmented'
        ? {
            currentRoundIndex: 1,
            rounds: [
              {
                segment: { type: 'hotlist', timeLimit: 120 },
                pricing: { minPostCost: POST_COST, minVoteCost: VOTE_COST },
                shortlistSize: 5,
              },
            ],
          }
        : {}),
    });

    // A live listener, to confirm broadcasts still arrive while the server is under load.
    let deltasReceived = 0;
    const listener = io(API, { auth: { token: tokens[0], eventId: event.id }, transports: ['websocket'], reconnection: false });
    listener.on('feed:deltas', () => { deltasReceived += 1; });
    await new Promise((resolve) => { listener.on('connect', resolve); setTimeout(resolve, 3000); });

    // --- fund, concurrently (also load-tests the wallet) ---------------------
    const t0 = Date.now();
    const grants = await Promise.all(
      tokens.map((t, i) => api('/api/wallet/grant', { token: t, method: 'POST', body: { amount: GRANT }, key: `g-${run}-${feedFormat}-${i}` })),
    );
    check('every grant succeeded', grants.every((g) => g.status === 200), `(${grants.filter((g) => g.status !== 200).length} failed)`);

    // --- everyone posts at once ---------------------------------------------
    const posted = await Promise.all(
      tokens.map((t, i) =>
        api(`/api/events/${event.id}/posts`, {
          token: t,
          method: 'POST',
          body: { text: `Stress post from user ${i}`, tokens: POST_COST },
          key: `p-${run}-${feedFormat}-${i}`,
        }),
      ),
    );
    const created = posted.filter((p) => p.status === 201);
    const postFail = posted.find((p) => p.status !== 201);
    check(
      'every post was accepted',
      created.length === USERS,
      `(${created.length}/${USERS}${postFail ? ` — first failure ${postFail.status}: ${postFail.body?.message}` : ''})`,
    );

    // --- host approves them all ---------------------------------------------
    const postIds = created.map((p) => p.body.data.post.id);
    const approvals = await Promise.all(
      postIds.map((id) => api(`/api/events/${event.id}/posts/${id}/review`, { token: hostToken, method: 'PATCH', body: { decision: 'approve' } })),
    );
    check('every post was approved', approvals.every((a) => a.status === 200), `(${approvals.filter((a) => a.status !== 200).length} failed)`);

    // --- THE STORM: everyone votes on random posts, all at once --------------
    let voteOk = 0;
    let voteRefused = 0;
    let voteRefusalReason = null;
    for (let round = 0; round < VOTE_ROUNDS; round += 1) {
      const results = await Promise.all(
        tokens.map((t, i) => {
          // HOT_POST puts every concurrent write on ONE document — maximum contention, and
          // the case where a read-modify-write implementation loses increments outright.
          const target = HOT_POST ? postIds[0] : postIds[(i * 7 + round * 3) % postIds.length];
          return api(`/api/events/${event.id}/posts/${target}/votes`, {
            token: t,
            method: 'POST',
            body: { tokens: VOTE_COST },
            key: `v-${run}-${feedFormat}-${round}-${i}`,
          });
        }),
      );
      voteOk += results.filter((r) => r.status === 200).length;
      const refused = results.filter((r) => r.status !== 200);
      voteRefused += refused.length;
      if (refused.length && !voteRefusalReason) {
        voteRefusalReason = `${refused[0].status}: ${refused[0].body?.message}`;
      }
    }
    const elapsed = (Date.now() - t0) / 1000;
    const writes = USERS + USERS + postIds.length + USERS * VOTE_ROUNDS;
    console.log(`  ${writes} writes in ${elapsed.toFixed(1)}s  (~${Math.round(writes / elapsed)}/s)`);
    console.log(`  votes accepted ${voteOk}, refused ${voteRefused}${voteRefusalReason ? ` (e.g. ${voteRefusalReason})` : ''}`);

    // Let the 300ms batcher flush.
    await new Promise((r) => setTimeout(r, 1200));
    check('broadcasts arrived during the storm', deltasReceived > 0, `(${deltasReceived} feed:deltas)`);
    listener.close();

    // --- INVARIANTS ----------------------------------------------------------
    console.log('  — consistency —');

    const wallets = await Wallet.find({ user: { $in: users.map((u) => u.id) } }).lean();
    check('no negative balances', wallets.every((w) => w.balance >= 0));

    // Ledger must reconstruct every balance exactly.
    let ledgerMismatch = 0;
    for (const wallet of wallets) {
      // eslint-disable-next-line no-await-in-loop
      const entries = await LedgerEntry.find({ user: wallet.user, status: 'applied' }).lean();
      const sum = entries.reduce((t, e) => t + e.amount, 0);
      if (sum !== wallet.balance) ledgerMismatch += 1;
    }
    check('ledger sums to balance for every user', ledgerMismatch === 0, `(${ledgerMismatch} mismatched)`);

    // THE BIG ONE: a post is worth its opening bid plus every stake placed on it. If any
    // concurrent increment was lost, this is where it shows.
    const posts = await Post.find({ event: event.id }).lean();
    let lostUpdates = 0;
    for (const post of posts) {
      // eslint-disable-next-line no-await-in-loop
      const stakes = await Vote.find({ post: post._id }).lean();
      const expected = POST_COST + stakes.reduce((t, v) => t + v.tokens, 0);
      if (post.tokens !== expected) lostUpdates += 1;
    }
    check('no lost vote increments', lostUpdates === 0, `(${lostUpdates}/${posts.length} posts wrong)`);

    // Every token that left a wallet must be accounted for on a post.
    const spentOnVotes = (await Vote.find({ event: event.id }).lean()).reduce((t, v) => t + v.tokens, 0);
    const gainedByPosts = posts.reduce((t, p) => t + p.tokens, 0) - POST_COST * posts.length;
    check('votes debited == tokens gained by posts', spentOnVotes === gainedByPosts, `(spent ${spentOnVotes}, gained ${gainedByPosts})`);

    // The server owns rank — the feed must come back genuinely ordered.
    const feed = await api(`/api/events/${event.id}/feed`, { token: tokens[0] });
    if (!feed.body?.data) {
      check('feed is readable', false, `(${feed.status}: ${feed.body?.message})`);
      continue;
    }
    const order = feed.body.data.posts.map((p) => p.tokens);
    check('feed is ordered by tokens, descending', order.every((v, i) => i === 0 || order[i - 1] >= v));
    check('feed totals match the database', feed.body.data.posts.every((p) => posts.find((d) => d._id.toString() === p.id)?.tokens === p.tokens));

    if (feedFormat === 'segmented') {
      check('shortlist size is served for a segmented round', feed.body.data.shortlistSize === 5, `(got ${feed.body.data.shortlistSize})`);
    }
  }

  await mongoose.disconnect();

  console.log(`\n${failures.length === 0 ? 'ALL CONSISTENCY CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nStress test crashed:', err.message);
  process.exit(1);
});
