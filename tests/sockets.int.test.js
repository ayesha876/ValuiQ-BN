/**
 * sockets.int.test.js — integration tests for the realtime layer, driving a REAL Socket.IO
 * server on a real port with a real client, against an in-memory MongoDB.
 *
 * The test that matters most is room isolation. A leak there means every attendee receives
 * every other event's traffic — no error, no crash, just other people's data arriving on the
 * wrong screens. Everything else here is an access-control case, and each one is written to
 * confirm a rejection is a rejection rather than a silent hang.
 *
 * Mirrors the setup in events.rounds.int.test.js: MongoMemoryServer, dynamic app import, and
 * models fetched from mongoose rather than re-imported (a second import recompiles the schema
 * and throws OverwriteModelError under Vitest's loader).
 */
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { io as ioClient } from 'socket.io-client';
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';

let mongod;
let httpServer;
let sockets;
let url;
let User;
let Event;
let ownerToken;
let attendeeToken;
let ownerId;

// Every client opened during a test, closed in afterEach — a leaked client keeps the run alive.
const openClients = [];

function connect(auth) {
  const client = ioClient(url, { auth, transports: ['websocket'], reconnection: false });
  openClients.push(client);
  return client;
}

/** Resolve on connect, or reject with the handshake error. Never hangs the suite. */
function settle(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out — neither connected nor refused')), 4000);
    client.on('connect', () => {
      clearTimeout(timer);
      resolve('connected');
    });
    client.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Wait for one named broadcast, or resolve null if it never arrives. */
function waitFor(client, name, ms = 600) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    client.on(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('valuiq_sockets_test'));

  const app = (await import('../app.js')).default;
  User = mongoose.model('User');
  Event = mongoose.model('Event');
  const { signLoginToken } = (await import('../src/shared/utils/generateToken.js')).default;
  sockets = await import('../src/sockets/socket.js');

  const owner = await User.create({ email: 'eo@sockets.test', role: 'Event Organizer', isVerified: true });
  const attendee = await User.create({ email: 'at@sockets.test', role: 'Attendee', isVerified: true });
  ownerId = owner.id;
  ownerToken = signLoginToken(owner);
  attendeeToken = signLoginToken(attendee);

  httpServer = http.createServer(app);
  sockets.initSockets(httpServer);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${httpServer.address().port}`;
});

afterEach(async () => {
  openClients.splice(0).forEach((client) => client.close());
  await Event.deleteMany({});
});

afterAll(async () => {
  await sockets.closeSockets();
  await new Promise((resolve) => httpServer.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
});

const liveEvent = (over = {}) =>
  Event.create({ name: 'Live One', slug: `live-${Math.random().toString(36).slice(2, 9)}`, owner: ownerId, status: 'live', ...over });

describe('handshake — who gets in', () => {
  it('accepts a valid token for a live event', async () => {
    const event = await liveEvent();
    await expect(settle(connect({ token: attendeeToken, eventId: event.id }))).resolves.toBe('connected');
  });

  it('refuses a connection with no token', async () => {
    const event = await liveEvent();
    await expect(settle(connect({ eventId: event.id }))).rejects.toThrow('Authentication required.');
  });

  it('refuses a malformed token', async () => {
    const event = await liveEvent();
    await expect(settle(connect({ token: 'not-a-jwt', eventId: event.id }))).rejects.toThrow(
      'Invalid authentication token.',
    );
  });

  it('refuses a connection with no eventId', async () => {
    await expect(settle(connect({ token: attendeeToken }))).rejects.toThrow('An eventId is required.');
  });

  it('refuses an unknown event', async () => {
    const missing = new mongoose.Types.ObjectId().toString();
    await expect(settle(connect({ token: attendeeToken, eventId: missing }))).rejects.toThrow('Event not found.');
  });

  it('refuses a malformed eventId rather than 500ing', async () => {
    // A CastError is a client problem here, not a server one.
    await expect(settle(connect({ token: attendeeToken, eventId: 'nonsense' }))).rejects.toThrow('Event not found.');
  });

  it('treats a soft-deleted event as not found', async () => {
    const event = await liveEvent();
    event.deletedAt = new Date();
    await event.save();
    await expect(settle(connect({ token: attendeeToken, eventId: event.id }))).rejects.toThrow('Event not found.');
  });
});

describe('handshake — drafts stay private', () => {
  it('refuses a non-owner on a draft event', async () => {
    const draft = await liveEvent({ status: 'draft' });
    await expect(settle(connect({ token: attendeeToken, eventId: draft.id }))).rejects.toThrow(
      'This event is not open yet.',
    );
  });

  it('lets the owner into their own draft', async () => {
    const draft = await liveEvent({ status: 'draft' });
    await expect(settle(connect({ token: ownerToken, eventId: draft.id }))).resolves.toBe('connected');
  });
});

describe('rooms', () => {
  it('DELIVERS ONLY TO THE EVENT THE SOCKET JOINED', async () => {
    // The most important test in this file. A room leak is silent: no error, no crash, just
    // one event's traffic arriving on another event's screens.
    const [eventA, eventB] = await Promise.all([liveEvent({ name: 'A' }), liveEvent({ name: 'B' })]);

    const clientA = connect({ token: attendeeToken, eventId: eventA.id });
    const clientB = connect({ token: attendeeToken, eventId: eventB.id });
    await Promise.all([settle(clientA), settle(clientB)]);

    const heardByA = waitFor(clientA, 'post:new');
    const heardByB = waitFor(clientB, 'post:new');

    sockets.emitToEvent(eventA.id, 'post:new', { post: { id: 'p1' } });

    expect(await heardByA).toEqual({ post: { id: 'p1' } });
    expect(await heardByB).toBeNull();
  });

  it('delivers to every socket in the same room', async () => {
    const event = await liveEvent();
    const one = connect({ token: attendeeToken, eventId: event.id });
    const two = connect({ token: ownerToken, eventId: event.id });
    await Promise.all([settle(one), settle(two)]);

    const heardByOne = waitFor(one, 'feed:deltas');
    const heardByTwo = waitFor(two, 'feed:deltas');

    sockets.emitToEvent(event.id, 'feed:deltas', { changed: [], order: [] });

    expect(await heardByOne).toEqual({ changed: [], order: [] });
    expect(await heardByTwo).toEqual({ changed: [], order: [] });
  });

  it('emitToEvent reports whether the layer was running', async () => {
    const event = await liveEvent();
    expect(sockets.emitToEvent(event.id, 'noop', {})).toBe(true);
  });
});

describe('teardown', () => {
  it('leaves no socket connected after a client disconnects', async () => {
    const event = await liveEvent();
    const client = connect({ token: attendeeToken, eventId: event.id });
    await settle(client);
    expect(sockets.getIo().sockets.sockets.size).toBe(1);

    client.close();
    // Give the server a moment to notice the transport closed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sockets.getIo().sockets.sockets.size).toBe(0);
  });
});
