/**
 * votes.int.test.js — integration tests for staking on posts, ranking, and the feed.
 *
 * Rank is TOTAL TOKENS STAKED — there is no vote count in this product. The tests that matter
 * most are the ones proving that: a stake changes the order, staking accumulates rather than
 * replaces, and a retried vote cannot inflate a post's rank for free.
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
let Wallet;
let Vote;
let walletService;
let host;
let voter;
let other;
let hostToken;
let voterToken;
let otherToken;

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const fund = (userId, amount) => walletService.credit({ userId, amount, type: 'grant' });
const balanceOf = async (userId) => (await Wallet.findOne({ user: userId }))?.balance ?? 0;

const liveEvent = (over = {}) =>
  Event.create({
    name: 'Vote Event',
    slug: `vote-${Math.random().toString(36).slice(2, 9)}`,
    owner: host.id,
    status: 'live',
    roundStartedAt: new Date(),
    segment: { type: 'hotlist', timeLimit: 30 },
    pricing: { minPostCost: 100, minVoteCost: 50 },
    ...over,
  });

/** A post that has already cleared review, with a known starting stake. */
const livePost = (event, tokens, over = {}) =>
  Post.create({
    event: event.id,
    author: host.id,
    authorName: 'Someone Else',
    text: `post worth ${tokens}`,
    tokens,
    status: 'live',
    roundIndex: 0,
    ...over,
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('valuiq_votes_test'));

  app = (await import('../app.js')).default;
  User = mongoose.model('User');
  Event = mongoose.model('Event');
  Post = mongoose.model('Post');
  Wallet = mongoose.model('Wallet');
  Vote = mongoose.model('Vote');
  walletService = (await import('../src/modules/wallet/wallet.service.js')).default;
  const { signLoginToken } = (await import('../src/shared/utils/generateToken.js')).default;

  // Unique indexes must exist before any test asserts a uniqueness guarantee — see
  // wallet.int.test.js for why.
  await Promise.all([Post.init(), Vote.init(), Wallet.init(), mongoose.model('LedgerEntry').init()]);

  host = await User.create({ email: 'host@votes.test', role: 'Event Organizer', isVerified: true });
  voter = await User.create({ email: 'priya.sharma@votes.test', role: 'Attendee', isVerified: true });
  other = await User.create({ email: 'david.kim@votes.test', role: 'Attendee', isVerified: true });

  hostToken = signLoginToken(host);
  voterToken = signLoginToken(voter);
  otherToken = signLoginToken(other);
});

afterEach(async () => {
  await Promise.all([
    Event.deleteMany({}),
    Post.deleteMany({}),
    Vote.deleteMany({}),
    Wallet.deleteMany({}),
    mongoose.connection.collection('ledgerentries').deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const vote = (event, post, token, tokens, key) => {
  const req = request(app).post(`/api/events/${event.id}/posts/${post.id}/votes`).set(bearer(token));
  if (key) req.set('Idempotency-Key', key);
  return req.send({ tokens });
};

describe('casting a vote', () => {
  it('debits the voter and raises the post total', async () => {
    const event = await liveEvent();
    const post = await livePost(event, 1000);
    await fund(voter.id, 500);

    const res = await vote(event, post, voterToken, 100);

    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(400);
    expect(res.body.data.post.tokens).toBe(1100);
    expect(res.body.data.post.myStake).toBe(100);
  });

  it('ACCUMULATES a repeat stake rather than replacing it', async () => {
    // "You spent 400 on this post" is a running total — backing the same post again adds.
    const event = await liveEvent();
    const post = await livePost(event, 1000);
    await fund(voter.id, 1000);

    await vote(event, post, voterToken, 100);
    const second = await vote(event, post, voterToken, 200);

    expect(second.body.data.post.myStake).toBe(300);
    expect(second.body.data.post.tokens).toBe(1300);
    expect(await balanceOf(voter.id)).toBe(700);
  });

  it('keeps each voter’s stake separate', async () => {
    const event = await liveEvent();
    const post = await livePost(event, 1000);
    await Promise.all([fund(voter.id, 500), fund(other.id, 500)]);

    await vote(event, post, voterToken, 100);
    const theirs = await vote(event, post, otherToken, 200);

    expect(theirs.body.data.post.myStake).toBe(200);
    expect(theirs.body.data.post.tokens).toBe(1300);
    expect(await Vote.countDocuments({ post: post.id })).toBe(2);
  });

  it('REFUSES AND CHARGES NOTHING when the balance is short', async () => {
    const event = await liveEvent();
    const post = await livePost(event, 1000);
    await fund(voter.id, 50);

    const res = await vote(event, post, voterToken, 100);

    expect(res.status).toBe(409);
    expect(await balanceOf(voter.id)).toBe(50);
    expect((await Post.findById(post.id)).tokens).toBe(1000);
  });

  it('rejects a stake below the event minimum', async () => {
    const event = await liveEvent();
    const post = await livePost(event, 1000);
    await fund(voter.id, 500);

    const res = await vote(event, post, voterToken, 10);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/minimum stake is 50/);
    expect(await balanceOf(voter.id)).toBe(500);
  });

  it('refuses to stake on a post still in review', async () => {
    // An in-review post is not visible to anyone else, so backing it would be spending on
    // something nobody can see.
    const event = await liveEvent();
    const pending = await livePost(event, 500, { status: 'in-review' });
    await fund(voter.id, 500);

    const res = await vote(event, pending, voterToken, 100);
    expect(res.status).toBe(409);
    expect(await balanceOf(voter.id)).toBe(500);
  });

  it('refuses a post belonging to another event', async () => {
    const [eventA, eventB] = await Promise.all([liveEvent(), liveEvent()]);
    const post = await livePost(eventA, 1000);
    await fund(voter.id, 500);

    const res = await vote(eventB, post, voterToken, 100);
    expect(res.status).toBe(404);
  });

  it('allows backing your own post', async () => {
    // The design shows an Upvote button on the "You" card; boosting your own question is a
    // legitimate way to spend tokens.
    const event = await liveEvent();
    const mine = await livePost(event, 500, { author: voter.id, authorName: 'Priya Sharma' });
    await fund(voter.id, 500);

    const res = await vote(event, mine, voterToken, 100);
    expect(res.status).toBe(200);
    expect(res.body.data.post.tokens).toBe(600);
  });
});

describe('idempotency — a retried vote must not inflate a rank', () => {
  it('charges once and raises the total once', async () => {
    const event = await liveEvent();
    const post = await livePost(event, 1000);
    await fund(voter.id, 500);

    await vote(event, post, voterToken, 100, 'vote-key-1');
    const replay = await vote(event, post, voterToken, 100, 'vote-key-1');

    expect(replay.status).toBe(200);
    expect(await balanceOf(voter.id)).toBe(400);
    expect((await Post.findById(post.id)).tokens).toBe(1100);
    expect(replay.body.data.post.myStake).toBe(100);
  });
});

describe('ranking — the server owns the order', () => {
  it('REORDERS THE FEED when a stake overtakes', async () => {
    const event = await liveEvent();
    const leader = await livePost(event, 1000, { text: 'was first' });
    const underdog = await livePost(event, 400, { text: 'was last' });
    await fund(voter.id, 1000);

    const before = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));
    expect(before.body.data.posts.map((p) => p.id)).toEqual([leader.id, underdog.id]);

    await vote(event, underdog, voterToken, 800); // 400 + 800 = 1200 > 1000

    const after = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));
    expect(after.body.data.posts.map((p) => p.id)).toEqual([underdog.id, leader.id]);
    expect(after.body.data.posts[0].tokens).toBe(1200);
  });

  it('breaks ties by age so the order does not shuffle between requests', async () => {
    const event = await liveEvent();
    const older = await livePost(event, 500, { text: 'older' });
    await new Promise((r) => setTimeout(r, 10));
    const newer = await livePost(event, 500, { text: 'newer' });

    const first = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));
    const second = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));

    expect(first.body.data.posts.map((p) => p.id)).toEqual([older.id, newer.id]);
    expect(second.body.data.posts.map((p) => p.id)).toEqual(first.body.data.posts.map((p) => p.id));
  });
});

describe('GET /feed', () => {
  it('returns only live posts, never the review queue', async () => {
    const event = await liveEvent();
    await livePost(event, 1000, { text: 'visible' });
    await livePost(event, 900, { text: 'hidden', status: 'in-review' });
    await livePost(event, 800, { text: 'refused', status: 'rejected' });

    const res = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));

    expect(res.body.data.posts).toHaveLength(1);
    expect(res.body.data.posts[0].text).toBe('visible');
    expect(res.body.data.total).toBe(1);
  });

  it('marks my own posts and my own stakes', async () => {
    const event = await liveEvent();
    const mine = await livePost(event, 500, { author: voter.id, authorName: 'Priya Sharma' });
    const theirs = await livePost(event, 900);
    await fund(voter.id, 500);
    await vote(event, theirs, voterToken, 100);

    const res = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));
    const byId = Object.fromEntries(res.body.data.posts.map((p) => [p.id, p]));

    expect(byId[mine.id].isMine).toBe(true);
    expect(byId[theirs.id].isMine).toBe(false);
    expect(byId[theirs.id].myStake).toBe(100);
    expect(byId[mine.id].myStake).toBe(0);
  });

  it('never exposes other people’s user ids', async () => {
    const event = await liveEvent();
    await livePost(event, 500);

    const res = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));
    expect(res.body.data.posts[0].author).toBeUndefined();
  });

  it('reports the minimum vote cost and the shortlist size for the live stage', async () => {
    const event = await liveEvent();
    const res = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));

    expect(res.body.data.minVoteCost).toBe(50);
    // The Opening Segment has no shortlistSize — everyone competes, round 1 applies the cut.
    expect(res.body.data.shortlistSize).toBeNull();
  });

  it('reports the shortlist size when a round is live', async () => {
    const event = await liveEvent({
      feedFormat: 'segmented',
      currentRoundIndex: 1,
      rounds: [
        {
          segment: { type: 'hotlist', timeLimit: 5 },
          pricing: { minPostCost: 100, minVoteCost: 75 },
          shortlistSize: 5,
        },
      ],
    });

    const res = await request(app).get(`/api/events/${event.id}/feed`).set(bearer(voterToken));
    expect(res.body.data.shortlistSize).toBe(5);
    expect(res.body.data.minVoteCost).toBe(75);
  });

  it('is not reachable for a draft event by a non-owner', async () => {
    const draft = await liveEvent({ status: 'draft' });
    const res = await request(app).get(`/api/events/${draft.id}/feed`).set(bearer(voterToken));
    expect(res.status).toBe(403);
  });
});

describe('concurrency', () => {
  it('never lets a burst of votes overspend a balance', async () => {
    const event = await liveEvent();
    const post = await livePost(event, 1000);
    await fund(voter.id, 500); // affords exactly 5 stakes of 100

    const attempts = Array.from({ length: 12 }, (_, i) => vote(event, post, voterToken, 100, `vrace-${i}`));
    const results = await Promise.all(attempts);

    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(5);
    expect(await balanceOf(voter.id)).toBe(0);
    // The post's total must reflect exactly what was actually paid for.
    expect((await Post.findById(post.id)).tokens).toBe(1500);
  });
});
