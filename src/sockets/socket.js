/**
 * socket.js — the realtime layer: one Socket.IO server, per-event rooms, one way to broadcast.
 *
 * WRITES GO OVER HTTP; READS COME BACK OVER THE SOCKET. This channel is read-only by
 * construction, not by convention: the server joins each socket to its room from the
 * handshake, and no `socket.on(...)` listener for client-sent events is registered anywhere.
 * A client physically cannot ask this layer to do anything.
 *
 * Feature modules never import `io`. They call `emitToEvent(eventId, name, payload)` and this
 * file decides where it goes — the same separation the repository layer gives the database.
 *
 * ⚠️ SINGLE PROCESS ONLY. Socket.IO's default adapter keeps rooms in memory, so with two or
 * more instances a broadcast reaches only the clients connected to the instance that sent it —
 * silently, with no error. Before scaling out, add @socket.io/redis-adapter (ioredis and
 * REDIS_URL are already available).
 */
const { Server } = require('socket.io');
const config = require('../shared/config/env');
const { roomForEvent } = require('./rooms');
const { resolveHandshake, SocketAuthError } = require('./socketAuth');
const { joinControlRoom, controlRoomFor } = require('./events/moderation.socket');

let io = null;

/**
 * Attach Socket.IO to the HTTP server.
 *
 * CORS uses the same allowlist as the REST API (`CLIENT_URL`, comma-separated) rather than a
 * second list — one place to add an origin, and no chance of the two disagreeing.
 */
function initSockets(httpServer) {
  const allowedOrigins = config.clientUrl
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      socket.data.identity = await resolveHandshake(socket.handshake.auth);
      return next();
    } catch (err) {
      if (err instanceof SocketAuthError) {
        // Permanent: rejecting here is correct, and the client will stop retrying.
        return next(err);
      }

      // TRANSIENT (the database is unreachable, say). Rejecting would strand the client on a
      // dead "Reconnecting…" forever, because a middleware rejection stops it retrying. So we
      // let the handshake succeed and drop the socket immediately instead: the client sees a
      // disconnect, which it DOES retry. See socketAuth.js for the measurement behind this.
      console.error('[sockets] Handshake failed for a non-permanent reason:', err.message);
      socket.data.dropImmediately = true;
      return next();
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.dropImmediately) {
      socket.disconnect(true);
      return;
    }

    const { eventId, userId } = socket.data.identity;
    // The SERVER joins the room, from the verified handshake. The client never asks — that is
    // what stops one attendee subscribing to another event's traffic.
    socket.join(roomForEvent(eventId));

    if (!config.isProduction) {
      console.log(`[sockets] ${userId} joined ${roomForEvent(eventId)}`);
    }

    // Moderators additionally join the control room, which carries the review queue and the
    // money riding on each undecided post. Attendees silently do not — a failed check is not
    // an error, it is the ordinary case for almost every connection, so it must never
    // disconnect a socket that is legitimately carrying the attendee feed.
    //
    // Fire-and-forget: the join is asynchronous (it reads the event and checks membership) and
    // nothing else about this connection depends on it.
    joinControlRoom(socket).catch((err) => {
      console.warn('[sockets] Control-room join failed (attendee feed unaffected):', err.message);
    });
  });

  return io;
}

/**
 * Broadcast to everyone watching one event.
 *
 * A no-op when sockets are not running (tests that only exercise HTTP, or a process started
 * without the realtime layer) so a broadcast can never be the reason a write fails. Emitting
 * an update is a side effect of the write, never a precondition for it.
 */
function emitToEvent(eventId, name, payload) {
  if (!io) return false;
  io.to(roomForEvent(eventId)).emit(name, payload);
  return true;
}

/**
 * Broadcast to the MODERATORS of one event, not its audience.
 *
 * The control room is a separate room from `event:<id>` precisely so queue payloads — which
 * carry each undecided post's financial exposure — never reach attendees. Using `emitToEvent`
 * for a queue message would leak exactly that, silently and to everyone.
 *
 * Same no-op-when-unavailable contract as `emitToEvent`: a broadcast is a side effect of a
 * write, never a precondition for it.
 *
 * @param {string} eventId - The event whose moderators should receive this.
 * @param {string} name - Event name, e.g. `'queue:post_added'`.
 * @param {object} payload - Serialisable body.
 * @returns {boolean} False when the realtime layer is not running.
 */
function emitToControlRoom(eventId, name, payload) {
  if (!io) return false;
  io.to(controlRoomFor(eventId)).emit(name, payload);
  return true;
}

/** The raw server, for tests and shutdown. Feature modules should use emitToEvent instead. */
function getIo() {
  return io;
}

/** Release the server so a test run (or a restart) leaves nothing listening. */
async function closeSockets() {
  if (!io) return;
  await io.close();
  io = null;
}

module.exports = { initSockets, emitToEvent, emitToControlRoom, getIo, closeSockets };
