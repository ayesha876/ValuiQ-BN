/**
 * dashboards.int.test.js — the three role-landing endpoints, against a real database.
 *
 * These back the screens each role lands on after login, so the failures worth guarding are the
 * ones that would strand somebody on an empty or wrong page:
 *
 *   - an attendee seeing events they never took part in (or missing ones they did)
 *   - a moderator's pending count being wrong, which is the number their workload is triaged by
 *   - `/api/moderator/events` answering 403 instead of an empty list, which would make
 *     "not invited anywhere yet" indistinguishable from "something is broken" — and would break
 *     the capability check the frontend's route guard depends on
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
let EventMember;
let walletService;
let signLoginTokenFn;

let host;
let moderator;
let attendee;
let stranger;
let hostToken;
let moderatorToken;
let attendeeToken;
let strangerToken;

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const liveEvent = (over = {}) =>
  Event.create({
    name: 'Dashboard Event',
    slug: `dash-${Math.random().toString(36).slice(2, 9)}`,
    owner: host.id,
    status: 'live',
    roundStartedAt: new Date(),
    segment: { type: 'instant', timeLimit: 120 },
    pricing: { minPostCost: 10, minVoteCost: 5 },
    neglectTimer: 300,
    revenueSharePct: 100,
    ...over,
  });

/** A post by `author`, in whatever state the test needs. */
const postBy = (event, author, over = {}) =>
  Post.create({
    event: event.id,
    author: author.id,
    authorName: 'Someone',
    text: 'A question worth answering',
    tokens: 100,
    openingStake: 100,
    status: 'in-review',
    roundIndex: 0,
    ...over,
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('valuiq_dashboards_test'));

  app = (await import('../app.js')).default;
  User = mongoose.model('User');
  Event = mongoose.model('Event');
  Post = mongoose.model('Post');
  Vote = mongoose.model('Vote');
  EventMember = mongoose.model('EventMember');

  walletService = (await import('../src/modules/wallet/wallet.service.js')).default;
  const { signLoginToken } = (await import('../src/shared/utils/generateToken.js')).default;
  signLoginTokenFn = signLoginToken;
}, 120_000);

beforeAll(async () => {
  host = await User.create({ email: 'jane.host@valuiq.local', role: 'Event Organizer', isVerified: true });
  moderator = await User.create({ email: 'marcus.rodriguez@valuiq.local', role: 'Attendee', isVerified: true });
  attendee = await User.create({ email: 'sarah.chen@valuiq.local', role: 'Attendee', isVerified: true });
  stranger = await User.create({ email: 'nobody@valuiq.local', role: 'Attendee', isVerified: true });

  hostToken = signLoginTokenFn(host);
  moderatorToken = signLoginTokenFn(moderator);
  attendeeToken = signLoginTokenFn(attendee);
  strangerToken = signLoginTokenFn(stranger);
});

afterEach(async () => {
  await Promise.all([
    Event.deleteMany({}),
    Post.deleteMany({}),
    Vote.deleteMany({}),
    EventMember.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('GET /api/attendee/tokens', () => {
  it('401s without a token', async () => {
    expect((await request(app).get('/api/attendee/tokens')).status).toBe(401);
  });

  it('shows a brand-new attendee a zero balance rather than failing', async () => {
    const res = await request(app).get('/api/attendee/tokens').set(bearer(strangerToken));

    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(0);
  });

  it('reports what the wallet actually holds', async () => {
    await walletService.credit({
      userId: attendee.id,
      amount: 15_420,
      type: 'grant',
      idempotencyKey: `t:${Math.random()}`,
    });

    const res = await request(app).get('/api/attendee/tokens').set(bearer(attendeeToken));

    expect(res.body.data.balance).toBe(15_420);
  });

  it('never reads another user’s wallet — there is no id in the path to swap', async () => {
    const res = await request(app).get('/api/attendee/tokens').set(bearer(strangerToken));
    expect(res.body.data.balance).toBe(0);
  });
});

describe('GET /api/attendee/events', () => {
  it('401s without a token', async () => {
    expect((await request(app).get('/api/attendee/events')).status).toBe(401);
  });

  it('returns an EMPTY LIST for someone who has never taken part', async () => {
    // Not an error and not a 403 — this is the honest answer, and the empty state says so.
    const event = await liveEvent();
    await postBy(event, attendee);

    const res = await request(app).get('/api/attendee/events').set(bearer(strangerToken));

    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('includes an event the attendee POSTED in', async () => {
    const event = await liveEvent();
    await postBy(event, attendee);

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].id).toBe(event.id);
  });

  it('includes an event the attendee only VOTED in', async () => {
    // Staking on someone else's post is participation too — missing this would hide every event
    // where the attendee backed a question rather than asking one.
    const event = await liveEvent();
    const post = await postBy(event, host, { status: 'live' });
    await Vote.create({ post: post.id, voter: attendee.id, event: event.id, tokens: 20 });

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events.map((e) => e.id)).toEqual([event.id]);
  });

  it('lists an event reached BOTH ways exactly once', async () => {
    const event = await liveEvent();
    const post = await postBy(event, attendee, { status: 'live' });
    await Vote.create({ post: post.id, voter: attendee.id, event: event.id, tokens: 20 });

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events).toHaveLength(1);
  });

  it('counts every distinct participant, not every post', async () => {
    const event = await liveEvent();
    await postBy(event, attendee);
    await postBy(event, attendee); // same person again
    const other = await postBy(event, host, { status: 'live' });
    await Vote.create({ post: other.id, voter: moderator.id, event: event.id, tokens: 10 });

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    // attendee + host + moderator = 3 people, from 3 posts and a vote.
    expect(res.body.data.events[0].attendeeCount).toBe(3);
  });

  it('names the host and every active moderator', async () => {
    const event = await liveEvent();
    await postBy(event, attendee);
    await EventMember.create({ user: moderator.id, event: event.id, status: 'active' });

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events[0].moderators).toEqual(['Jane Host', 'Marcus Rodriguez']);
  });

  it('leaves out a REVOKED moderator', async () => {
    const event = await liveEvent();
    await postBy(event, attendee);
    await EventMember.create({ user: moderator.id, event: event.id, status: 'revoked' });

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events[0].moderators).toEqual(['Jane Host']);
  });

  it('reports postingOpen TRUE while the window is still running', async () => {
    const event = await liveEvent();
    await postBy(event, attendee);

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events[0].postingOpen).toBe(true);
    expect(res.body.data.events[0].secondsRemaining).toBeGreaterThan(0);
  });

  it('reports postingOpen FALSE once the window has closed', async () => {
    // The Join button gates on this. A closed window behind an enabled button is a dead end.
    const event = await liveEvent({
      roundStartedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      segment: { type: 'instant', timeLimit: 1 },
    });
    await postBy(event, attendee);

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events[0].postingOpen).toBe(false);
    expect(res.body.data.events[0].secondsRemaining).toBe(0);
  });

  it('reports postingOpen FALSE for an event that is not live', async () => {
    const event = await liveEvent({ status: 'ended' });
    await postBy(event, attendee);

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events[0].postingOpen).toBe(false);
  });

  it('hides a soft-deleted event', async () => {
    const event = await liveEvent({ deletedAt: new Date() });
    await postBy(event, attendee);

    const res = await request(app).get('/api/attendee/events').set(bearer(attendeeToken));

    expect(res.body.data.events).toEqual([]);
  });
});

describe('GET /api/moderator/events', () => {
  it('401s without a token', async () => {
    expect((await request(app).get('/api/moderator/events')).status).toBe(401);
  });

  it('⚠️ returns an EMPTY LIST, not 403, for someone who moderates nothing', async () => {
    // This is the capability check the frontend route guard depends on. A 403 here would make
    // "not invited anywhere yet" look identical to a permissions failure, and would send an
    // ordinary attendee to /unauthorized instead of showing them an empty moderator area.
    const res = await request(app).get('/api/moderator/events').set(bearer(strangerToken));

    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('gives a HOST their own events, without an invite', async () => {
    const event = await liveEvent();

    const res = await request(app).get('/api/moderator/events').set(bearer(hostToken));

    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].isOwner).toBe(true);
  });

  it('gives an INVITED moderator the event, whatever their global role', async () => {
    // This moderator registered as an Attendee — the common case, and the one a global-role
    // check would have locked out.
    const event = await liveEvent();
    await EventMember.create({ user: moderator.id, event: event.id, status: 'active' });

    const res = await request(app).get('/api/moderator/events').set(bearer(moderatorToken));

    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].isInvited).toBe(true);
    expect(res.body.data.events[0].isOwner).toBe(false);
  });

  it('does NOT give a revoked moderator the event', async () => {
    const event = await liveEvent();
    await EventMember.create({ user: moderator.id, event: event.id, status: 'revoked' });

    const res = await request(app).get('/api/moderator/events').set(bearer(moderatorToken));

    expect(res.body.data.events).toEqual([]);
  });

  it('names the host of each event', async () => {
    await liveEvent();
    const res = await request(app).get('/api/moderator/events').set(bearer(hostToken));

    expect(res.body.data.events[0].hostName).toBe('Jane Host');
  });

  it('counts only posts still awaiting a decision', async () => {
    const event = await liveEvent();
    await postBy(event, attendee); // in-review  -> pending
    await postBy(event, attendee, { status: 'live' }); // live -> still decidable
    await postBy(event, attendee, { status: 'addressed' }); // settled -> not pending
    await postBy(event, attendee, { status: 'rejected' }); // not decidable -> not pending

    const res = await request(app).get('/api/moderator/events').set(bearer(hostToken));

    expect(res.body.data.events[0].pendingCount).toBe(2);
  });

  it('breaks settled work down by OUTCOME, not into approve/reject', async () => {
    // Neglected is not "rejected": every staker was refunded and the host earned nothing.
    // Collapsing the three would hide the one that cost the host money.
    const event = await liveEvent();
    const ModerationDecision = mongoose.model('ModerationDecision');
    const p1 = await postBy(event, attendee, { status: 'addressed' });
    const p2 = await postBy(event, attendee, { status: 'dismissed' });
    const p3 = await postBy(event, attendee, { status: 'neglected' });

    await ModerationDecision.create([
      { post: p1.id, event: event.id, decision: 'address', source: 'moderator', status: 'applied' },
      { post: p2.id, event: event.id, decision: 'dismiss', source: 'moderator', status: 'applied' },
      { post: p3.id, event: event.id, decision: 'neglect', source: 'system', status: 'applied' },
    ]);

    const res = await request(app).get('/api/moderator/events').set(bearer(hostToken));

    expect(res.body.data.events[0].decisions).toEqual({
      addressed: 1,
      dismissed: 1,
      neglected: 1,
      total: 3,
    });
  });

  it('ignores decisions that never finished applying', async () => {
    const event = await liveEvent();
    const ModerationDecision = mongoose.model('ModerationDecision');
    const post = await postBy(event, attendee);
    await ModerationDecision.create({
      post: post.id,
      event: event.id,
      decision: 'address',
      source: 'moderator',
      status: 'pending',
    });

    const res = await request(app).get('/api/moderator/events').set(bearer(hostToken));

    expect(res.body.data.events[0].decisions.total).toBe(0);
  });

  it('hides a soft-deleted event', async () => {
    await liveEvent({ deletedAt: new Date() });

    const res = await request(app).get('/api/moderator/events').set(bearer(hostToken));

    expect(res.body.data.events).toEqual([]);
  });
});
