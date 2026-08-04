/**
 * moderation.int.test.js — Week 4 end to end, against a real database.
 *
 * This is the file that actually proves the money is right. It drives the real Express app
 * with Supertest, against a real (in-memory) MongoDB, through the real wallet and the real
 * revenue ledger. Nothing is stubbed.
 *
 * The assertions that matter most are the ones about DOUBLE MOVEMENT: a refund that happens
 * twice cannot be undone, so a retried, raced, or swept-and-decided post must settle exactly
 * once. Those are checked against balances and ledger rows, not against a return value.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';

let mongod;
let app;
let User;
let Event;
let Post;
let Vote;
let Wallet;
let LedgerEntry;
let ModerationDecision;
let HostRevenueEntry;
let HostWallet;
let walletService;
let fairnessWorker;
// Captured inside beforeAll, because the module is loaded there — a module-level const would
// capture undefined and every token in the suite would be unsignable.
let signLoginTokenFn;

let host;
let moderator;
let attendee;
let backer;
let outsider;
let hostToken;
let moderatorToken;
let attendeeToken;
let outsiderToken;

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const liveEvent = (over = {}) =>
  Event.create({
    name: 'Moderation Event',
    slug: `mod-${Math.random().toString(36).slice(2, 9)}`,
    owner: host.id,
    status: 'live',
    roundStartedAt: new Date(),
    segment: { type: 'instant', timeLimit: 30 },
    pricing: { minPostCost: 10, minVoteCost: 5 },
    neglectTimer: 300,
    revenueSharePct: 100,
    ...over,
  });

/**
 * A post that has cleared review and is live in the feed, with real stakes behind it.
 *
 * Created through the models rather than the API so a test can set up an exact financial
 * position without also asserting the posting flow, which posts.int.test.js already covers.
 */
const livePost = async (event, { author = attendee, openingStake = 100, over = {} } = {}) => {
  const post = await Post.create({
    event: event.id,
    author: author.id,
    authorName: 'Test Author',
    text: 'Why did the roadmap change?',
    tokens: openingStake,
    openingStake,
    status: 'live',
    roundIndex: 0,
    neglectDeadlineAt: new Date(Date.now() + 300_000),
    ...over,
  });
  return post;
};

/** Back a post, exactly as vote.service would: post total up, vote row created. */
const stake = async (post, voter, tokens) => {
  await Post.updateOne({ _id: post.id }, { $inc: { tokens } });
  await Vote.findOneAndUpdate(
    { post: post.id, voter: voter.id },
    { $inc: { tokens }, $setOnInsert: { event: post.event } },
    { upsert: true, setDefaultsOnInsert: true },
  );
};

/** Give an attendee tokens they actually PAID for, so the host can earn real money from them. */
const purchase = (userId, tokens, cents) =>
  walletService.credit({
    userId,
    amount: tokens,
    type: 'purchase',
    fiatCents: cents,
    idempotencyKey: `buy:${userId}:${Math.random().toString(36).slice(2)}`,
  });

const balanceOf = async (userId) => (await Wallet.findOne({ user: userId }))?.balance ?? 0;
const decide = (event, token, body) =>
  request(app).post(`/api/events/${event.id}/moderation/decisions`).set(bearer(token)).send(body);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('valuiq_moderation_test'));

  app = (await import('../app.js')).default;
  User = mongoose.model('User');
  Event = mongoose.model('Event');
  Post = mongoose.model('Post');
  Vote = mongoose.model('Vote');
  Wallet = mongoose.model('Wallet');
  LedgerEntry = mongoose.model('LedgerEntry');
  ModerationDecision = mongoose.model('ModerationDecision');
  HostRevenueEntry = mongoose.model('HostRevenueEntry');
  HostWallet = mongoose.model('HostWallet');

  walletService = (await import('../src/modules/wallet/wallet.service.js')).default;
  fairnessWorker = (await import('../src/jobs/workers/fairnessTimer.worker.js')).default;
  const { signLoginToken } = (await import('../src/shared/utils/generateToken.js')).default;
  signLoginTokenFn = signLoginToken;

  // The unique indexes ARE the concurrency guarantees under test — they must exist before any
  // test asserts that a retry cannot pay or refund twice. Same reasoning as wallet.int.test.js.
  await Promise.all([
    Post.init(),
    Wallet.init(),
    LedgerEntry.init(),
    ModerationDecision.init(),
    HostRevenueEntry.init(),
    HostWallet.init(),
    Vote.init(),
  ]);

  [host, moderator, attendee, backer, outsider] = await Promise.all([
    User.create({ email: 'host@mod.test', role: 'Event Organizer', isVerified: true }),
    User.create({ email: 'mod@mod.test', role: 'Attendee', isVerified: true }),
    User.create({ email: 'attendee@mod.test', role: 'Attendee', isVerified: true }),
    User.create({ email: 'backer@mod.test', role: 'Attendee', isVerified: true }),
    User.create({ email: 'outsider@mod.test', role: 'Attendee', isVerified: true }),
  ]);

  hostToken = signLoginToken(host);
  moderatorToken = signLoginToken(moderator);
  attendeeToken = signLoginToken(attendee);
  outsiderToken = signLoginToken(outsider);
});

afterAll(async () => {
  await fairnessWorker.stopFairnessTimer();
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Promise.all([
    Event.deleteMany({}),
    Post.deleteMany({}),
    Vote.deleteMany({}),
    Wallet.deleteMany({}),
    LedgerEntry.deleteMany({}),
    ModerationDecision.deleteMany({}),
    HostRevenueEntry.deleteMany({}),
    HostWallet.deleteMany({}),
  ]);
});

describe('POST /decisions — authorization', () => {
  it('401s without a token', async () => {
    const event = await liveEvent();
    const post = await livePost(event);

    const res = await request(app)
      .post(`/api/events/${event.id}/moderation/decisions`)
      .send({ postId: post.id, decision: 'address' });

    expect(res.status).toBe(401);
  });

  it('403s for a user who is neither the owner nor an event moderator', async () => {
    const event = await liveEvent();
    const post = await livePost(event);

    const res = await decide(event, outsiderToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(403);
    expect(await ModerationDecision.countDocuments()).toBe(0);
  });

  it('lets the event OWNER decide on their own event', async () => {
    const event = await liveEvent();
    const post = await livePost(event);

    const res = await decide(event, hostToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(201);
  });

  it('lets an ACTIVE EventMember decide, whatever their global role', async () => {
    // The moderator here registered as an Attendee — gating on the vestigial global
    // 'Moderator' role would have locked them out, which is why the route does not.
    const event = await liveEvent();
    const post = await livePost(event);
    await mongoose.model('EventMember').create({ user: moderator.id, event: event.id, status: 'active' });

    const res = await decide(event, moderatorToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(201);
  });
});

/**
 * ⚠️ NOBODY SETTLES THEIR OWN POST.
 *
 * `requireEventModerator` proves you may decide posts in this event; it says nothing about WHOSE
 * post. Both moderator roles can also be authors — the host may post into their own event, and an
 * EventMember is an ordinary attendee with a badge — so without an explicit check a moderator can
 * settle the post they wrote themselves.
 *
 * The harm is not abstract. On Address, the OTHER people who staked on that post have their
 * tokens converted into the host's earnings instead of being refunded, chosen by the one person
 * with an interest in that outcome — and the audit trail records it as an ordinary decision.
 */
describe('POST /decisions — self-review', () => {
  it('REFUSES a host settling their own post', async () => {
    const event = await liveEvent();
    const post = await livePost(event, { author: host });

    const res = await decide(event, hostToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/your own post/i);
  });

  it('REFUSES a moderator settling their own post', async () => {
    const event = await liveEvent();
    await mongoose.model('EventMember').create({ user: moderator.id, event: event.id, status: 'active' });
    const post = await livePost(event, { author: moderator });

    const res = await decide(event, moderatorToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(403);
  });

  it('books NOTHING when a self-review is refused', async () => {
    // The assertion that matters: refused at the door, before the claim is taken. A 403 that
    // still left a decision row or a revenue entry behind would be worse than no guard at all,
    // because the post would then be permanently undecidable by anyone else.
    const event = await liveEvent();
    await purchase(host.id, 500, 10_000); // 20c per token
    const post = await livePost(event, { author: host, openingStake: 100 });

    await decide(event, hostToken, { postId: post.id, decision: 'address' });

    expect(await HostRevenueEntry.countDocuments({ post: post.id })).toBe(0);
    expect(await ModerationDecision.countDocuments({ post: post.id })).toBe(0);
    expect((await Post.findById(post.id)).status).toBe('live');
  });

  it('leaves the post decidable BY SOMEBODY ELSE', async () => {
    // A refusal must not strand the post. Another moderator settles it normally, which is the
    // whole point of refusing rather than silently allowing it.
    const event = await liveEvent();
    await mongoose.model('EventMember').create({ user: moderator.id, event: event.id, status: 'active' });
    const post = await livePost(event, { author: host });

    expect((await decide(event, hostToken, { postId: post.id, decision: 'address' })).status).toBe(403);

    const res = await decide(event, moderatorToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(201);
    expect((await Post.findById(post.id)).status).toBe('addressed');
  });

  it('still lets the fairness timer neglect a moderator’s own post', async () => {
    // `source: 'system'` is exempt by construction — the worker has no identity to collide with
    // the author's. Without that exemption a moderator could park their own post beyond every
    // deadline simply by never being allowed to settle it.
    const event = await liveEvent();
    await purchase(host.id, 500, 10_000);
    const post = await livePost(event, {
      author: host,
      openingStake: 100,
      over: { neglectDeadlineAt: new Date(Date.now() - 1_000) },
    });

    await fairnessWorker.sweepOverdue();

    const decision = await ModerationDecision.findOne({ post: post.id });
    expect(decision?.decision).toBe('neglect');
    expect(decision?.source).toBe('system');
    expect((await Post.findById(post.id)).status).toBe('neglected');
  });
});

describe('POST /decisions — validation', () => {
  it('400s on an unknown decision', async () => {
    const event = await liveEvent();
    const post = await livePost(event);

    const res = await decide(event, hostToken, { postId: post.id, decision: 'delete' });

    expect(res.status).toBe(400);
  });

  it('400s on an unknown key — the mass-assignment guard', async () => {
    // ⚠️ `moderatorId` in particular: the brief put it in the body, and accepting it would let
    // one moderator write another's name into a permanent money audit trail.
    const event = await liveEvent();
    const post = await livePost(event);

    const res = await decide(event, hostToken, {
      postId: post.id,
      decision: 'address',
      moderatorId: outsider.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/moderatorId/i);
  });

  it('400s on a malformed post id', async () => {
    const event = await liveEvent();

    const res = await decide(event, hostToken, { postId: 'nope', decision: 'address' });

    expect(res.status).toBe(400);
  });

  it('404s for a post belonging to a different event', async () => {
    const [eventA, eventB] = await Promise.all([liveEvent(), liveEvent()]);
    const post = await livePost(eventB);

    const res = await decide(eventA, hostToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(404);
  });

  it('422s for a post that was rejected at the publication gate', async () => {
    const event = await liveEvent();
    const post = await livePost(event, { over: { status: 'rejected' } });

    const res = await decide(event, hostToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(422);
  });
});

describe('the three outcomes — the host-earn / refund rule', () => {
  /**
   * A post worth exactly $75.00 of real money.
   *
   * Two attendees, both of whom paid 25c per token: the author stakes 100 (2500c) and a backer
   * stakes 200 (5000c). 300 tokens on the post, 7500c of realised value behind it.
   */
  async function postWorth7500(event) {
    await purchase(attendee.id, 100, 2500); // 25c/token
    await purchase(backer.id, 200, 5000); // 25c/token
    const post = await livePost(event, { author: attendee, openingStake: 100 });
    await stake(post, backer, 200);
    return post;
  }

  it('ADDRESS books the host 100% and refunds nobody', async () => {
    const event = await liveEvent();
    const post = await postWorth7500(event);
    const before = { attendee: await balanceOf(attendee.id), backer: await balanceOf(backer.id) };

    const res = await decide(event, hostToken, { postId: post.id, decision: 'address' });

    expect(res.status).toBe(201);
    expect(res.body.data.financials.hostEarnedCents).toBe(7500);
    expect(res.body.data.financials.refundedTokens).toBe(0);
    expect(res.body.data.post.status).toBe('addressed');

    // Nobody was refunded.
    expect(await balanceOf(attendee.id)).toBe(before.attendee);
    expect(await balanceOf(backer.id)).toBe(before.backer);

    // The host really holds the money.
    const wallet = await HostWallet.findOne({ host: host.id });
    expect(wallet.pendingCents).toBe(7500);
  });

  it('DISMISS books the host 50% and still refunds nobody', async () => {
    // ValuiQ_Client_Overview §9: "Dismissed -> Half the value of tokens spent". NOT the
    // financially-neutral reading the Week 4 brief proposed.
    const event = await liveEvent();
    const post = await postWorth7500(event);
    const before = await balanceOf(attendee.id);

    const res = await decide(event, hostToken, { postId: post.id, decision: 'dismiss' });

    expect(res.status).toBe(201);
    expect(res.body.data.financials.hostEarnedCents).toBe(3750);
    expect(res.body.data.post.status).toBe('dismissed');
    expect(await balanceOf(attendee.id)).toBe(before);

    const entry = await HostRevenueEntry.findOne({ post: post.id });
    expect(entry.decisionPct).toBe(50);
    expect(entry.grossValueCents).toBe(7500);
  });

  it('NEGLECT refunds every staker in full and books the host nothing', async () => {
    const event = await liveEvent();
    const post = await postWorth7500(event);
    const before = { attendee: await balanceOf(attendee.id), backer: await balanceOf(backer.id) };

    const res = await decide(event, hostToken, { postId: post.id, decision: 'neglect' });

    expect(res.status).toBe(201);
    expect(res.body.data.financials.hostEarnedCents).toBe(0);
    expect(res.body.data.financials.refundedTokens).toBe(300);
    expect(res.body.data.financials.stakerCount).toBe(2);

    // ⚠️ THE AUTHOR IS REFUNDED TOO. They have no Vote row — their stake lives on the post —
    // so a refund built only from vote rows would silently miss the one person who started it.
    expect(await balanceOf(attendee.id)).toBe(before.attendee + 100);
    expect(await balanceOf(backer.id)).toBe(before.backer + 200);

    expect(await HostRevenueEntry.countDocuments({ post: post.id })).toBe(0);
  });

  it('applies a per-event revenue share on top of the decision multiplier', async () => {
    const event = await liveEvent({ revenueSharePct: 80 });
    const post = await postWorth7500(event);

    const res = await decide(event, hostToken, { postId: post.id, decision: 'address' });

    // 7500 × 0.80 × 1.00
    expect(res.body.data.financials.hostEarnedCents).toBe(6000);
  });

  it('books nothing real when every token was granted rather than bought', async () => {
    // The state of every attendee today, before Stripe lands. Tokens are still refundable on
    // neglect, but no REAL money exists for the host to earn.
    const event = await liveEvent();
    await walletService.credit({ userId: attendee.id, amount: 500, type: 'grant' });
    const post = await livePost(event, { author: attendee, openingStake: 100 });

    const res = await decide(event, hostToken, { postId: post.id, decision: 'address' });

    expect(res.body.data.financials.hostEarnedCents).toBe(0);
    expect(await HostRevenueEntry.countDocuments()).toBe(0);
    expect(await HostWallet.findOne({ host: host.id })).toBeNull();
  });
});

describe('⚠️ exactly-once — the guarantee that protects the money', () => {
  it('a retried NEGLECT refunds once, not twice', async () => {
    const event = await liveEvent();
    await purchase(attendee.id, 200, 5000);
    const post = await livePost(event, { author: attendee, openingStake: 100 });
    const before = await balanceOf(attendee.id);

    const first = await decide(event, hostToken, { postId: post.id, decision: 'neglect' });
    const second = await decide(event, hostToken, { postId: post.id, decision: 'neglect' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200); // replayed, nothing new created
    expect(second.body.data.financials.refundedTokens).toBe(100);

    // THE ASSERTION THAT MATTERS: one refund, not two.
    expect(await balanceOf(attendee.id)).toBe(before + 100);
    expect(await LedgerEntry.countDocuments({ 'ref.postId': post.id, type: 'refund' })).toBe(1);
  });

  it('a retried ADDRESS pays the host once, not twice', async () => {
    const event = await liveEvent();
    await purchase(attendee.id, 100, 2500);
    const post = await livePost(event, { author: attendee, openingStake: 100 });

    await decide(event, hostToken, { postId: post.id, decision: 'address' });
    const second = await decide(event, hostToken, { postId: post.id, decision: 'address' });

    expect(second.status).toBe(200);
    expect(await HostRevenueEntry.countDocuments({ post: post.id })).toBe(1);
    expect((await HostWallet.findOne({ host: host.id })).pendingCents).toBe(2500);
  });

  it('CONCURRENT decisions settle exactly once', async () => {
    // Two moderators clicking at the same instant. The unique index on ModerationDecision.post
    // is the whole mechanism — this is the test that proves it works without a transaction.
    const event = await liveEvent();
    await purchase(attendee.id, 200, 5000);
    const post = await livePost(event, { author: attendee, openingStake: 100 });
    const before = await balanceOf(attendee.id);
    await mongoose.model('EventMember').create({ user: moderator.id, event: event.id, status: 'active' });

    const results = await Promise.all([
      decide(event, hostToken, { postId: post.id, decision: 'neglect' }),
      decide(event, moderatorToken, { postId: post.id, decision: 'neglect' }),
      decide(event, hostToken, { postId: post.id, decision: 'neglect' }),
    ]);

    // Every caller gets a usable answer — one 201, the rest 200 or 409, never a 500.
    expect(results.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);

    expect(await ModerationDecision.countDocuments({ post: post.id })).toBe(1);
    expect(await balanceOf(attendee.id)).toBe(before + 100);
    expect(await LedgerEntry.countDocuments({ 'ref.postId': post.id, type: 'refund' })).toBe(1);
  });

  it('refuses a SECOND, DIFFERENT decision with 409', async () => {
    const event = await liveEvent();
    await purchase(attendee.id, 200, 5000);
    const post = await livePost(event, { author: attendee, openingStake: 100 });

    await decide(event, hostToken, { postId: post.id, decision: 'address' });
    const res = await decide(event, hostToken, { postId: post.id, decision: 'neglect' });

    expect(res.status).toBe(409);
    // The address stands, and nobody was refunded by the failed attempt.
    expect((await Post.findById(post.id)).status).toBe('addressed');
    expect(await LedgerEntry.countDocuments({ type: 'refund' })).toBe(0);
  });

  it('freezes the post so a late stake cannot land after settlement', async () => {
    // The post leaves 'live', and `addTokens` only matches 'live' — so the vote is refused at
    // the door rather than being charged for and then never refunded.
    const event = await liveEvent();
    await purchase(backer.id, 500, 10_000);
    const post = await livePost(event, { author: attendee, openingStake: 100 });

    await decide(event, hostToken, { postId: post.id, decision: 'address' });

    const res = await request(app)
      .post(`/api/events/${event.id}/posts/${post.id}/votes`)
      .set(bearer(signLoginTokenFor(backer)))
      .send({ tokens: 50 });

    expect(res.status).toBe(409);
    expect(await balanceOf(backer.id)).toBe(500); // charged nothing
  });
});

describe('the fairness timer — auto-neglect', () => {
  it('refunds an overdue post with no manual action, and records it as system', async () => {
    const event = await liveEvent();
    await purchase(attendee.id, 200, 5000);
    const post = await livePost(event, {
      author: attendee,
      openingStake: 100,
      over: { neglectDeadlineAt: new Date(Date.now() - 1_000) }, // already overdue
    });
    const before = await balanceOf(attendee.id);

    const result = await fairnessWorker.sweepOverdue();

    expect(result.settled).toBe(1);
    expect(await balanceOf(attendee.id)).toBe(before + 100);

    const decision = await ModerationDecision.findOne({ post: post.id });
    expect(decision.decision).toBe('neglect');
    // The brief's requirement, and the signal that a host missed their own SLA.
    expect(decision.source).toBe('system');
    expect(decision.moderator).toBeNull();
    expect((await Post.findById(post.id)).status).toBe('neglected');
  });

  it('does NOT double-refund a post a moderator already settled', async () => {
    const event = await liveEvent();
    await purchase(attendee.id, 200, 5000);
    const post = await livePost(event, {
      author: attendee,
      openingStake: 100,
      over: { neglectDeadlineAt: new Date(Date.now() - 1_000) },
    });

    await decide(event, hostToken, { postId: post.id, decision: 'neglect' });
    const balanceAfterModerator = await balanceOf(attendee.id);

    const result = await fairnessWorker.sweepOverdue();

    expect(result.settled).toBe(0); // nothing left to settle
    expect(await balanceOf(attendee.id)).toBe(balanceAfterModerator);
    expect(await LedgerEntry.countDocuments({ 'ref.postId': post.id, type: 'refund' })).toBe(1);
  });

  it('leaves a post alone until its deadline actually passes', async () => {
    const event = await liveEvent();
    await livePost(event, { over: { neglectDeadlineAt: new Date(Date.now() + 60_000) } });

    const result = await fairnessWorker.sweepOverdue();

    expect(result.settled).toBe(0);
  });

  it('never times out a post whose stage set no timer', async () => {
    const event = await liveEvent({ neglectTimer: 0 });
    await livePost(event, { over: { neglectDeadlineAt: null } });

    const result = await fairnessWorker.sweepOverdue();

    expect(result.examined).toBe(0);
  });

  it('is safe to run concurrently — N sweeps refund each post once', async () => {
    // Proves the worker is horizontally scalable: settlement is claimed through a unique
    // index, so extra instances are harmless rather than dangerous.
    const event = await liveEvent();
    await purchase(attendee.id, 300, 7500);
    const post = await livePost(event, {
      author: attendee,
      openingStake: 150,
      over: { neglectDeadlineAt: new Date(Date.now() - 1_000) },
    });
    const before = await balanceOf(attendee.id);

    await Promise.all([fairnessWorker.sweepOverdue(), fairnessWorker.sweepOverdue(), fairnessWorker.sweepOverdue()]);

    expect(await balanceOf(attendee.id)).toBe(before + 150);
    expect(await ModerationDecision.countDocuments({ post: post.id })).toBe(1);
    expect(await LedgerEntry.countDocuments({ 'ref.postId': post.id, type: 'refund' })).toBe(1);
  });
});

describe('GET /queue/review', () => {
  it('orders by urgency, then oldest first', async () => {
    const event = await liveEvent();
    const now = Date.now();

    // Deliberately created newest-first so a naive implementation that just returns insertion
    // order would fail.
    const calm = await livePost(event, { over: { neglectDeadlineAt: new Date(now + 3_600_000), tokens: 10 } });
    const urgent = await livePost(event, { over: { neglectDeadlineAt: new Date(now + 20_000), tokens: 10 } });

    const res = await request(app)
      .get(`/api/events/${event.id}/queue/review`)
      .set(bearer(hostToken));

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i) => i.id)).toEqual([urgent.id, calm.id]);
    expect(res.body.data.items[0].severity).toBe('critical');
  });

  it('reports financial exposure in both currencies', async () => {
    const event = await liveEvent();
    await purchase(attendee.id, 100, 2500);
    const post = await livePost(event, { author: attendee, openingStake: 100 });

    const res = await request(app).get(`/api/events/${event.id}/queue/review`).set(bearer(hostToken));

    const row = res.body.data.items.find((i) => i.id === post.id);
    expect(row.financialExposure).toEqual({ tokensAtRisk: 100, stakerCount: 1, hostForfeitCents: 2500 });
  });

  it('drops a post from the queue once it is decided', async () => {
    const event = await liveEvent();
    const post = await livePost(event);

    await decide(event, hostToken, { postId: post.id, decision: 'address' });
    const res = await request(app).get(`/api/events/${event.id}/queue/review`).set(bearer(hostToken));

    expect(res.body.data.items).toHaveLength(0);
  });

  it('403s for someone with no moderator authority over the event', async () => {
    const event = await liveEvent();
    await livePost(event);

    const res = await request(app).get(`/api/events/${event.id}/queue/review`).set(bearer(outsiderToken));

    expect(res.status).toBe(403);
  });

  it('400s on an unknown query parameter', async () => {
    const event = await liveEvent();

    const res = await request(app)
      .get(`/api/events/${event.id}/queue/review?staus=FLAGGED`)
      .set(bearer(hostToken));

    expect(res.status).toBe(400);
  });
});

describe('GET /revenue/host/:hostId/summary', () => {
  it('totals what the host has earned', async () => {
    const event = await liveEvent();
    await purchase(attendee.id, 200, 5000); // 25c/token
    const a = await livePost(event, { author: attendee, openingStake: 100 });
    const b = await livePost(event, { author: attendee, openingStake: 100 });

    await decide(event, hostToken, { postId: a.id, decision: 'address' }); // 2500
    await decide(event, hostToken, { postId: b.id, decision: 'dismiss' }); // 1250

    const res = await request(app).get(`/api/revenue/host/${host.id}/summary`).set(bearer(hostToken));

    expect(res.status).toBe(200);
    expect(res.body.data.summary.bookedCents).toBe(3750);
    expect(res.body.data.summary.pendingCents).toBe(3750);
    expect(res.body.data.summary.entryCount).toBe(2);
  });

  it('403s when one host asks for another host’s earnings', async () => {
    const res = await request(app).get(`/api/revenue/host/${host.id}/summary`).set(bearer(outsiderToken));

    expect(res.status).toBe(403);
  });

  it('returns zeroes for a host who has never earned, rather than 404', async () => {
    const res = await request(app).get(`/api/revenue/host/${host.id}/summary`).set(bearer(hostToken));

    expect(res.status).toBe(200);
    expect(res.body.data.summary.pendingCents).toBe(0);
  });
});

describe('GET /moderation/decisions — the audit trail', () => {
  it('lists what was decided, by whom, and what it cost', async () => {
    const event = await liveEvent();
    await purchase(attendee.id, 100, 2500);
    const post = await livePost(event, { author: attendee, openingStake: 100 });

    await decide(event, hostToken, { postId: post.id, decision: 'address', reason: 'Great question' });

    const res = await request(app)
      .get(`/api/events/${event.id}/moderation/decisions`)
      .set(bearer(hostToken));

    expect(res.status).toBe(200);
    expect(res.body.data.decisions).toHaveLength(1);
    expect(res.body.data.decisions[0]).toMatchObject({
      decision: 'address',
      source: 'moderator',
      reason: 'Great question',
      hostEarnedCents: 2500,
    });
  });
});

/** Hoisted function declaration, so the tests above can call it before this line is reached. */
function signLoginTokenFor(user) {
  return signLoginTokenFn(user);
}
