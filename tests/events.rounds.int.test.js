/**
 * events.rounds.int.test.js — integration tests for Row 3, driving the REAL Express app
 * against an in-memory MongoDB (mongodb-memory-server). Covers the DB-dependent slices of
 * Section A (persistence, the service go-live rule, the segmented->open []-clear, non-draft
 * 409-with-rounds) and Section B regressions (backward compat, strict, the moderator bridge,
 * assertGoLiveReady untouched).
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';

let mongod;
let app;
let User;
let Event;
let token;

const auth = () => ({ Authorization: `Bearer ${token}` });
const validRound = {
  segment: { type: 'hotlist', timeLimit: 10, submissionLimit: 50 },
  pricing: { minPostCost: 10, minVoteCost: 5 },
  neglectTimer: 30,
  shortlistSize: 10,
};
const future = (days) => new Date(Date.now() + days * 86400000).toISOString();
const goLiveOpen = () => ({
  intent: 'live',
  name: 'Go Live Open',
  feedFormat: 'open',
  startDate: future(1),
  endDate: future(2),
  pricing: { minPostCost: 5, minVoteCost: 2 },
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('valuiq_row3_test'));

  app = (await import('../app.js')).default;
  // The app's require chain already compiled the Mongoose models; fetch them from
  // mongoose rather than re-importing the model files (a second import recompiles the
  // schema and throws OverwriteModelError under Vitest's loader).
  User = mongoose.model('User');
  Event = mongoose.model('Event');
  const { signLoginToken } = (await import('../src/shared/utils/generateToken.js')).default;

  const owner = await User.create({ email: 'eo@test.local', role: 'Event Organizer', isVerified: true });
  token = signLoginToken(owner);
});

afterEach(async () => {
  await Event.deleteMany({});
  await mongoose.connection.collection('moderatorinvites').deleteMany({}).catch(() => {});
  await mongoose.connection.collection('eventmembers').deleteMany({}).catch(() => {});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('Section A — new behaviour (persistence)', () => {
  it('open + no rounds -> 201, feedFormat open, rounds []', async () => {
    const res = await request(app).post('/api/events').set(auth()).send({ name: 'Open', feedFormat: 'open' });
    expect(res.status).toBe(201);
    expect(res.body.data.event.feedFormat).toBe('open');
    expect(res.body.data.event.rounds).toEqual([]);
  });

  it('segmented draft + valid rounds -> 201, persists with an id', async () => {
    const res = await request(app)
      .post('/api/events')
      .set(auth())
      .send({ name: 'Seg', feedFormat: 'segmented', rounds: [validRound] });
    expect(res.status).toBe(201);
    expect(res.body.data.event.rounds).toHaveLength(1);
    expect(res.body.data.event.rounds[0].id).toBeDefined();
    expect(res.body.data.event.rounds[0]._id).toBeUndefined();
    expect(res.body.data.event.rounds[0].segment.submissionLimit).toBe(50);
    expect(res.body.data.event.rounds[0].shortlistSize).toBe(10);
  });

  it('save -> reload round-trips the rounds (GET returns what was sent)', async () => {
    const created = (
      await request(app)
        .post('/api/events')
        .set(auth())
        .send({ name: 'Seg', feedFormat: 'segmented', rounds: [validRound] })
    ).body.data.event;
    const res = await request(app).get(`/api/events/${created.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.event.feedFormat).toBe('segmented');
    expect(res.body.data.event.rounds[0].pricing.minPostCost).toBe(10);
    expect(res.body.data.event.rounds[0].shortlistSize).toBe(10);
  });
});

describe('Section A — service go-live rule (segmented)', () => {
  it('go-live segmented with 0 rounds -> 400 from the SERVICE', async () => {
    const res = await request(app).post('/api/events').set(auth()).send({ ...goLiveOpen(), feedFormat: 'segmented' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one round/i);
  });

  it('go-live segmented with a round missing shortlistSize -> 400', async () => {
    const res = await request(app)
      .post('/api/events')
      .set(auth())
      .send({ ...goLiveOpen(), feedFormat: 'segmented', rounds: [{ segment: { type: 'hotlist' } }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/shortlist size/i);
  });

  it('go-live segmented with a valid round -> 201 (non-draft)', async () => {
    const res = await request(app)
      .post('/api/events')
      .set(auth())
      .send({ ...goLiveOpen(), feedFormat: 'segmented', rounds: [validRound] });
    expect(res.status).toBe(201);
    expect(res.body.data.event.status).not.toBe('draft');
  });

  // The go-live rule must read the MERGED event, not the PATCH body. A host goes live by
  // PATCHing { intent:'live' } on an existing draft WITHOUT re-sending feedFormat/rounds —
  // so the rule has to see the persisted feedFormat:'segmented' + 0 rounds and still 400.
  // (The create-based test above re-sends feedFormat, so it never exercised this path.)
  it('go-live via PATCH intent:live on a persisted 0-round segmented draft -> 400 (merged read)', async () => {
    const created = (
      await request(app)
        .post('/api/events')
        .set(auth())
        .send({
          name: 'SegDraft',
          feedFormat: 'segmented',
          startDate: future(1),
          endDate: future(2),
          pricing: { minPostCost: 5, minVoteCost: 2 },
        })
    ).body.data.event;
    expect(created.status).toBe('draft');
    expect(created.rounds).toHaveLength(0);

    const res = await request(app)
      .patch(`/api/events/${created.id}`)
      .set(auth())
      .send({ intent: 'live' }); // nothing else — forces the service to read persisted state
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one round/i);

    const doc = await Event.findById(created.id);
    expect(doc.status).toBe('draft'); // did NOT transition
  });
});

describe('Section A — the segmented->open []-clear trap + non-draft lock', () => {
  it('PATCH segmented draft -> open with rounds:[] actually clears rounds in Mongo', async () => {
    const created = (
      await request(app)
        .post('/api/events')
        .set(auth())
        .send({ name: 'Seg', feedFormat: 'segmented', rounds: [validRound] })
    ).body.data.event;

    const patch = await request(app)
      .patch(`/api/events/${created.id}`)
      .set(auth())
      .send({ feedFormat: 'open', rounds: [] });
    expect(patch.status).toBe(200);
    expect(patch.body.data.event.rounds).toEqual([]);

    const doc = await Event.findById(created.id);
    expect(doc.feedFormat).toBe('open');
    expect(doc.rounds).toHaveLength(0);
  });

  it('non-draft PATCH with rounds -> 409, rounds unchanged in Mongo', async () => {
    const created = (await request(app).post('/api/events').set(auth()).send(goLiveOpen())).body.data.event;
    expect(created.status).not.toBe('draft');

    const patch = await request(app)
      .patch(`/api/events/${created.id}`)
      .set(auth())
      .send({ feedFormat: 'segmented', rounds: [validRound] });
    expect(patch.status).toBe(409);

    const doc = await Event.findById(created.id);
    expect(doc.feedFormat).toBe('open');
    expect(doc.rounds).toHaveLength(0);
  });
});

describe('Section B — regressions', () => {
  it('legacy payload with no feedFormat/rounds -> 201, defaults to open', async () => {
    const res = await request(app).post('/api/events').set(auth()).send({ name: 'Legacy', description: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.data.event.feedFormat).toBe('open');
    expect(res.body.data.event.rounds).toEqual([]);
  });

  it('still rejects an unknown top-level key -> 400', async () => {
    const res = await request(app).post('/api/events').set(auth()).send({ name: 'X', owner: 'abc123' });
    expect(res.status).toBe(400);
  });

  it('assertGoLiveReady unchanged — open go-live missing dates -> 400', async () => {
    const res = await request(app)
      .post('/api/events')
      .set(auth())
      .send({ intent: 'live', name: 'NoDates', feedFormat: 'open', pricing: { minPostCost: 1, minVoteCost: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/start date/i);
  });

  it('moderator bridge still fires: create-form moderators appear as Pending', async () => {
    const created = (
      await request(app)
        .post('/api/events')
        .set(auth())
        .send({ name: 'WithMods', moderators: [{ name: 'Al', email: 'al@test.local' }] })
    ).body.data.event;

    const list = await request(app).get(`/api/events/${created.id}/moderators`).set(auth());
    expect(list.status).toBe(200);
    const pending = list.body.data.moderators.filter((m) => m.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].email).toBe('al@test.local');
  });

  it('re-saving a draft with the same moderator creates NO duplicate invite', async () => {
    const created = (
      await request(app)
        .post('/api/events')
        .set(auth())
        .send({ name: 'WithMods', moderators: [{ name: 'Al', email: 'al@test.local' }] })
    ).body.data.event;

    await request(app)
      .patch(`/api/events/${created.id}`)
      .set(auth())
      .send({ moderators: [{ name: 'Al', email: 'al@test.local' }] });

    const list = await request(app).get(`/api/events/${created.id}/moderators`).set(auth());
    const pending = list.body.data.moderators.filter((m) => m.status === 'pending');
    expect(pending).toHaveLength(1);
  });
});
