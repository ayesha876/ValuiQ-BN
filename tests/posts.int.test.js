/**
 * posts.int.test.js — integration tests for paid posts and the review queue.
 *
 * This is the first module that joins the wallet to the realtime layer, so the tests that
 * matter most are the ones about MONEY: a refused post must cost nothing, a retried post must
 * cost once, and concurrent posts must not overspend a balance.
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
let walletService;
let host;
let attendee;
let outsider;
let hostToken;
let attendeeToken;
let outsiderToken;

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const liveEvent = (over = {}) =>
  Event.create({
    name: 'Live Event',
    slug: `live-${Math.random().toString(36).slice(2, 9)}`,
    owner: host.id,
    status: 'live',
    roundStartedAt: new Date(),
    segment: { type: 'instant', timeLimit: 30 },
    pricing: { minPostCost: 100, minVoteCost: 50 },
    ...over,
  });

const fund = (userId, amount) => walletService.credit({ userId, amount, type: 'grant' });
const balanceOf = async (userId) => (await Wallet.findOne({ user: userId }))?.balance ?? 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('valuiq_posts_test'));

  app = (await import('../app.js')).default;
  User = mongoose.model('User');
  Event = mongoose.model('Event');
  Post = mongoose.model('Post');
  Wallet = mongoose.model('Wallet');
  walletService = (await import('../src/modules/wallet/wallet.service.js')).default;
  const { signLoginToken } = (await import('../src/shared/utils/generateToken.js')).default;

  // See wallet.int.test.js — the unique index on idempotencyKey must exist before any test
  // asserts that a retried submit cannot pay twice.
  await Promise.all([Post.init(), Wallet.init(), mongoose.model('LedgerEntry').init()]);

  host = await User.create({ email: 'sarah.chen@posts.test', role: 'Event Organizer', isVerified: true });
  attendee = await User.create({ email: 'marcus.rodriguez@posts.test', role: 'Attendee', isVerified: true });
  outsider = await User.create({ email: 'nobody@posts.test', role: 'Attendee', isVerified: true });

  hostToken = signLoginToken(host);
  attendeeToken = signLoginToken(attendee);
  outsiderToken = signLoginToken(outsider);
});

afterEach(async () => {
  await Promise.all([
    Event.deleteMany({}),
    Post.deleteMany({}),
    Wallet.deleteMany({}),
    mongoose.connection.collection('ledgerentries').deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('POST /posts — submitting costs tokens', () => {
  it('debits the stake and holds the post for review', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 500);

    const res = await request(app)
      .post(`/api/events/${event.id}/posts`)
      .set(bearer(attendeeToken))
      .send({ text: 'Does this actually cost tokens?', tokens: 200 });

    expect(res.status).toBe(201);
    expect(res.body.data.post.status).toBe('in-review');
    expect(res.body.data.post.tokens).toBe(200);
    expect(res.body.data.balance).toBe(300);
    expect(await balanceOf(attendee.id)).toBe(300);
  });

  it('derives a readable author name from the account', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 500);

    const res = await request(app)
      .post(`/api/events/${event.id}/posts`)
      .set(bearer(attendeeToken))
      .send({ text: 'Who wrote this?', tokens: 100 });

    // marcus.rodriguez@... -> "Marcus Rodriguez". The User model has no name field.
    expect(res.body.data.post.authorName).toBe('Marcus Rodriguez');
  });

  it('REFUSES AND CHARGES NOTHING when the balance is short', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 50);

    const res = await request(app)
      .post(`/api/events/${event.id}/posts`)
      .set(bearer(attendeeToken))
      .send({ text: 'Cannot afford this', tokens: 200 });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Not enough tokens/);
    expect(await balanceOf(attendee.id)).toBe(50);
    expect(await Post.countDocuments({})).toBe(0);
  });

  it('rejects a stake below the event minimum before charging', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 500);

    const res = await request(app)
      .post(`/api/events/${event.id}/posts`)
      .set(bearer(attendeeToken))
      .send({ text: 'Too cheap', tokens: 10 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/minimum to post is 100/);
    expect(await balanceOf(attendee.id)).toBe(500);
  });

  it('refuses to post to an event that is not live', async () => {
    const draft = await liveEvent({ status: 'scheduled' });
    await fund(attendee.id, 500);

    const res = await request(app)
      .post(`/api/events/${draft.id}/posts`)
      .set(bearer(attendeeToken))
      .send({ text: 'Too early', tokens: 200 });

    expect(res.status).toBe(409);
    expect(await balanceOf(attendee.id)).toBe(500);
  });

  it('keeps a draft event private to its owner', async () => {
    const draft = await liveEvent({ status: 'draft' });
    await fund(attendee.id, 500);

    const res = await request(app)
      .post(`/api/events/${draft.id}/posts`)
      .set(bearer(attendeeToken))
      .send({ text: 'Peeking', tokens: 200 });

    expect(res.status).toBe(403);
  });

  it('rejects an unknown field rather than silently ignoring it', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 500);

    const res = await request(app)
      .post(`/api/events/${event.id}/posts`)
      .set(bearer(attendeeToken))
      .send({ text: 'Sneaky', tokens: 200, status: 'live' });

    expect(res.status).toBe(400);
  });
});

describe('submissionLimit — N, finally enforced', () => {
  it('stops an attendee at their configured cap', async () => {
    const event = await liveEvent({ segment: { type: 'instant', timeLimit: 30, submissionLimit: 2 } });
    await fund(attendee.id, 1000);

    const send = (text) =>
      request(app).post(`/api/events/${event.id}/posts`).set(bearer(attendeeToken)).send({ text, tokens: 100 });

    expect((await send('one')).status).toBe(201);
    expect((await send('two')).status).toBe(201);

    const third = await send('three');
    expect(third.status).toBe(409);
    expect(third.body.message).toMatch(/all 2 of your submissions/);

    // The refused third post must not have been charged for.
    expect(await balanceOf(attendee.id)).toBe(800);
  });

  it('caps each attendee separately', async () => {
    const event = await liveEvent({ segment: { type: 'instant', timeLimit: 30, submissionLimit: 1 } });
    await Promise.all([fund(attendee.id, 500), fund(outsider.id, 500)]);

    const a = await request(app).post(`/api/events/${event.id}/posts`).set(bearer(attendeeToken)).send({ text: 'mine', tokens: 100 });
    const b = await request(app).post(`/api/events/${event.id}/posts`).set(bearer(outsiderToken)).send({ text: 'theirs', tokens: 100 });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });
});

describe('idempotency — a retried submit must not pay twice', () => {
  it('returns the same post and charges once', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 500);

    const send = () =>
      request(app)
        .post(`/api/events/${event.id}/posts`)
        .set(bearer(attendeeToken))
        .set('Idempotency-Key', 'post-key-1')
        .send({ text: 'Only once please', tokens: 200 });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(201);
    expect(second.body.data.post.id).toBe(first.body.data.post.id);
    expect(await Post.countDocuments({})).toBe(1);
    expect(await balanceOf(attendee.id)).toBe(300);
  });
});

describe('concurrency — the wallet guarantee holds through this path', () => {
  it('never spends more than the balance, however many posts arrive at once', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 500); // affords exactly 5 posts at 100

    const attempts = Array.from({ length: 12 }, (_, i) =>
      request(app)
        .post(`/api/events/${event.id}/posts`)
        .set(bearer(attendeeToken))
        .set('Idempotency-Key', `race-post-${i}`)
        .send({ text: `burst ${i}`, tokens: 100 }),
    );
    const results = await Promise.all(attempts);

    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(5);
    expect(await balanceOf(attendee.id)).toBe(0);
    expect(await Post.countDocuments({})).toBe(5);
  });
});

describe('the review queue', () => {
  it('is visible to the organizer and lists what is waiting', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 500);
    await request(app).post(`/api/events/${event.id}/posts`).set(bearer(attendeeToken)).send({ text: 'waiting', tokens: 100 });

    const res = await request(app).get(`/api/events/${event.id}/posts/queue`).set(bearer(hostToken));

    expect(res.status).toBe(200);
    expect(res.body.data.posts).toHaveLength(1);
    expect(res.body.data.posts[0].status).toBe('in-review');
  });

  it('is NOT visible to an ordinary attendee', async () => {
    const event = await liveEvent();
    const res = await request(app).get(`/api/events/${event.id}/posts/queue`).set(bearer(attendeeToken));
    expect(res.status).toBe(403);
  });
});

describe('review decisions', () => {
  async function submitOne(event) {
    await fund(attendee.id, 500);
    const res = await request(app)
      .post(`/api/events/${event.id}/posts`)
      .set(bearer(attendeeToken))
      .send({ text: 'Decide on me', tokens: 100 });
    return res.body.data.post.id;
  }

  it('approving takes a post live', async () => {
    const event = await liveEvent();
    const postId = await submitOne(event);

    const res = await request(app)
      .patch(`/api/events/${event.id}/posts/${postId}/review`)
      .set(bearer(hostToken))
      .send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body.data.post.status).toBe('live');
    expect(res.body.data.post.approvedAt).not.toBeNull();
  });

  it('rejecting marks it rejected — and refunds nothing, by design', async () => {
    // The refund rule is genuinely undecided: the purchase modal says 50-100% back to the
    // attendee, QinMvpDocs says a dismissed post refunds nothing. Until that is settled,
    // rejecting must not invent a policy.
    const event = await liveEvent();
    const postId = await submitOne(event);

    const res = await request(app)
      .patch(`/api/events/${event.id}/posts/${postId}/review`)
      .set(bearer(hostToken))
      .send({ decision: 'reject' });

    expect(res.body.data.post.status).toBe('rejected');
    expect(await balanceOf(attendee.id)).toBe(400);
  });

  it('cannot be reviewed twice — the second moderator is told', async () => {
    const event = await liveEvent();
    const postId = await submitOne(event);
    const url = `/api/events/${event.id}/posts/${postId}/review`;

    await request(app).patch(url).set(bearer(hostToken)).send({ decision: 'approve' });
    const second = await request(app).patch(url).set(bearer(hostToken)).send({ decision: 'reject' });

    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already been reviewed/);
  });

  it('an attendee cannot approve their own post', async () => {
    const event = await liveEvent();
    const postId = await submitOne(event);

    const res = await request(app)
      .patch(`/api/events/${event.id}/posts/${postId}/review`)
      .set(bearer(attendeeToken))
      .send({ decision: 'approve' });

    expect(res.status).toBe(403);
  });

  it('a post from another event is not found', async () => {
    const [eventA, eventB] = await Promise.all([liveEvent(), liveEvent()]);
    const postId = await submitOne(eventA);

    const res = await request(app)
      .patch(`/api/events/${eventB.id}/posts/${postId}/review`)
      .set(bearer(hostToken))
      .send({ decision: 'approve' });

    expect(res.status).toBe(404);
  });
});

describe('GET /arena', () => {
  it('returns balance, my posts, the window and the current round', async () => {
    const event = await liveEvent();
    await fund(attendee.id, 500);
    await request(app).post(`/api/events/${event.id}/posts`).set(bearer(attendeeToken)).send({ text: 'mine', tokens: 100 });

    const res = await request(app).get(`/api/events/${event.id}/arena`).set(bearer(attendeeToken));

    expect(res.status).toBe(200);
    expect(res.body.data.me.balance).toBe(400);
    expect(res.body.data.me.posts).toHaveLength(1);
    expect(res.body.data.currentRound).toEqual({ index: 0, shortlistSize: null });
  });

  it('computes the window from when the event actually went live', async () => {
    const startedAt = new Date();
    const event = await liveEvent({ roundStartedAt: startedAt, segment: { type: 'instant', timeLimit: 3 } });

    const res = await request(app).get(`/api/events/${event.id}/arena`).set(bearer(attendeeToken));

    const endsAt = new Date(res.body.data.window.endsAt).getTime();
    expect(endsAt - startedAt.getTime()).toBe(3 * 60_000);
    expect(res.body.data.window.serverNow).toBeTruthy();
  });

  it('returns no window when the event has not started', async () => {
    const event = await liveEvent({ roundStartedAt: null });
    const res = await request(app).get(`/api/events/${event.id}/arena`).set(bearer(attendeeToken));
    expect(res.body.data.window).toBeNull();
  });

  it('shows a new attendee a zero balance rather than failing', async () => {
    const event = await liveEvent();
    const res = await request(app).get(`/api/events/${event.id}/arena`).set(bearer(outsiderToken));
    expect(res.body.data.me.balance).toBe(0);
  });
});
