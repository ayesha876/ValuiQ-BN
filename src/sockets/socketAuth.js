/**
 * socketAuth.js — proves WHO is connecting and WHICH event they may listen to.
 *
 * The HTTP equivalent is auth.middleware + rbac.middleware, and this mirrors their
 * discipline: identity comes from the verified token and nothing else, a missing event is
 * indistinguishable from one that was soft-deleted, and the check fails closed.
 *
 * ── Why rejections here are so carefully chosen ────────────────────────────────────────
 * A Socket.IO middleware rejection is TERMINAL. The client sets `socket.active = false`,
 * stops retrying, and never emits `reconnect_failed` — measured during the frontend work:
 * with the server refusing, exactly one attempt arrives in 30+ seconds, then silence.
 *
 * So middleware may only reject things that will never succeed on a retry. Everything below
 * is permanent: a bad token stays bad, a deleted event stays deleted. A TRANSIENT failure
 * (the database being briefly unreachable) must NOT be rejected here — see `socket.js`,
 * which disconnects those instead, because a disconnect is something the client does retry.
 */
const { verifyLoginToken } = require('../shared/utils/generateToken');
const eventRepo = require('../modules/events/event.repository');
const { participationDenialReason } = require('../modules/events/event.access');

/** Thrown for a permanent failure — the caller turns this into a handshake rejection. */
class SocketAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SocketAuthError';
    this.isPermanent = true;
  }
}

/**
 * Decide whether this handshake may listen to this event.
 *
 * The rule itself lives in events/event.access.js, shared with the HTTP post routes, so the
 * two transports can never disagree about who is allowed into an event.
 */
function assertMayListen({ event, userId }) {
  const reason = participationDenialReason({ event, userId });
  if (reason) throw new SocketAuthError(reason);
}

/**
 * The handshake. Resolves to `{ userId, role, eventId }` on success.
 *
 * Throws SocketAuthError for anything permanent. Any OTHER error (a database failure) is
 * left to propagate untouched, so the caller can tell the two apart and handle them
 * differently — that distinction is the whole point.
 */
async function resolveHandshake(handshakeAuth = {}) {
  const { token, eventId } = handshakeAuth;

  if (!token) throw new SocketAuthError('Authentication required.');
  if (!eventId) throw new SocketAuthError('An eventId is required.');

  // Any verify failure is a client problem, never a server one — same rule as
  // auth.middleware.js, where expired and malformed both land on 401.
  let payload;
  try {
    payload = verifyLoginToken(token);
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'
        ? 'Your session has expired. Please log in again.'
        : 'Invalid authentication token.';
    throw new SocketAuthError(message);
  }

  // A malformed id would make Mongoose throw a CastError, which is a client problem here,
  // not a server one — so it is caught and reported as a permanent rejection.
  let event;
  try {
    event = await eventRepo.findActiveById(eventId);
  } catch (err) {
    if (err.name === 'CastError') throw new SocketAuthError('Event not found.');
    throw err; // a real database failure — deliberately NOT a rejection
  }

  // Soft-deleted reads as not-found, exactly as it does for the HTTP routes.
  if (!event) throw new SocketAuthError('Event not found.');

  assertMayListen({ event, userId: payload.sub });

  return { userId: payload.sub, role: payload.role, eventId: event.id.toString() };
}

module.exports = { resolveHandshake, SocketAuthError };
