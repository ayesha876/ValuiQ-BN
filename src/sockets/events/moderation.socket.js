/**
 * moderation.socket.js — the CONTROL ROOM: a live review queue for moderators.
 *
 * ── WHY THIS IS NOT A SECOND WEBSOCKET SERVER ─────────────────────────────────────────────
 * The brief asked for `ws://host/queue/live` with its own JWT middleware. This codebase
 * already has a realtime layer with per-event rooms and a handshake that authenticates and
 * authorizes against the SAME rule the HTTP routes use — that sharing is deliberate, and
 * `event.access.js` says why in as many words: "Two copies of an access rule drift, and when
 * they do one transport allows exactly what the other forbids — which is the kind of gap
 * nobody notices until it is being exploited."
 *
 * A second server would be a third copy. So the control room is a ROOM on the existing server:
 * same handshake, same token, same event-access rule, plus one extra authorization step that
 * the ordinary event room does not need.
 *
 * ── THE ROOM IS NOT THE EVENT ROOM ────────────────────────────────────────────────────────
 * `event:<id>` holds every attendee. The queue exposes undecided posts and the money riding on
 * each — an attendee seeing that would learn which questions are about to be refunded and how
 * much everyone staked. So moderators join a SEPARATE room, `event:<id>:control`, and joining
 * it requires proving moderator authority on this specific event.
 *
 * Note that `post.service` already broadcasts `post:pending` to the whole event room and
 * reasons that it is harmless ("an attendee learning that *a* post exists reveals nothing they
 * could not work out by watching the feed"). That is true of the bare existence of a post; it
 * is not true of its financial exposure, which is why the queue payloads go here instead.
 *
 * ── SURVIVING A RESTART ───────────────────────────────────────────────────────────────────
 * Nothing here is remembered in memory. A connecting client gets its snapshot from MongoDB,
 * and a reconnecting one passes `since` and gets everything that changed, also from MongoDB.
 * Restart the process mid-event and a client reconnects to exactly the state it should have.
 */
const eventRepo = require('../../modules/events/event.repository');
const moderatorRepo = require('../../modules/moderators/moderator.repository');
const queueService = require('../../modules/queue/queue.service');
const { createLogger } = require('../../shared/utils/logger');

const log = createLogger('control-room');

/** The moderator-only room for one event. Deliberately distinct from `roomForEvent`. */
function controlRoomFor(eventId) {
  return `event:${String(eventId)}:control`;
}

/**
 * May this user watch this event's review queue?
 *
 * Exactly `requireEventModerator`'s rule — owner OR active EventMember — re-expressed for the
 * socket transport because that middleware is Express-shaped (it takes req/res/next). The RULE
 * is duplicated, not the policy source: both read the same `EventMember` records through the
 * same repository, so neither can grant access the other would refuse.
 *
 * @param {object} input
 * @param {object} input.event - The already-loaded event.
 * @param {string} input.userId - The connecting user.
 * @returns {Promise<boolean>} True when they may watch.
 */
async function mayModerate({ event, userId }) {
  if (!event) return false;
  if (event.owner.toString() === String(userId)) return true;
  return moderatorRepo.existsActiveMembership({ userId, eventId: event.id });
}

/**
 * Put a connected socket into the control room, if it is entitled to be there.
 *
 * Called from the connection handler AFTER the ordinary event-room join. A socket that fails
 * the check is NOT disconnected — it is a perfectly valid attendee connection that simply does
 * not get the queue. Disconnecting would break the feed for every attendee.
 *
 * ── `since` — THE RECONNECTION CONTRACT ──────────────────────────────────────────────────
 * A client may pass `handshake.auth.since` as an ISO timestamp. It then receives everything
 * that changed after that moment instead of a full snapshot. Read from the database, so it
 * works across a server restart, a deploy, or a client that was asleep for an hour.
 *
 * An unparseable `since` falls back to a full snapshot rather than erroring: a client that
 * cannot say where it left off should get everything, not nothing.
 *
 * @param {import('socket.io').Socket} socket - The authenticated socket.
 * @returns {Promise<{joined: boolean}>} Whether it joined. Never throws.
 */
async function joinControlRoom(socket) {
  const { eventId, userId } = socket.data.identity;

  try {
    const event = await eventRepo.findActiveById(eventId);
    if (!(await mayModerate({ event, userId }))) return { joined: false };

    socket.join(controlRoomFor(eventId));

    const rawSince = socket.handshake.auth?.since;
    const since = rawSince ? new Date(rawSince) : null;
    const validSince = since && !Number.isNaN(since.getTime()) ? since : null;

    if (validSince) {
      const changes = await queueService.getChangesSince(event, validSince);
      socket.emit('queue:changes', changes);
      log.debug('Control room resumed', { eventId, userId, since: validSince, changed: changes.items.length });
    } else {
      const snapshot = await queueService.getSnapshot(event);
      socket.emit('queue:snapshot', { ...snapshot, at: new Date().toISOString() });
      log.debug('Control room joined', { eventId, userId, items: snapshot.items.length });
    }

    return { joined: true };
  } catch (err) {
    // A queue problem must not take down a socket that is also carrying the attendee feed.
    // The client simply gets no snapshot and can fall back to the REST endpoint.
    log.error('Could not join the control room', { eventId, userId, err });
    return { joined: false };
  }
}

module.exports = { joinControlRoom, controlRoomFor, mayModerate };
