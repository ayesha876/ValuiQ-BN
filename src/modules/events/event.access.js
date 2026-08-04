/**
 * event.access.js — the single definition of WHO MAY TAKE PART IN AN EVENT.
 *
 * Used by both the Socket.IO handshake and the HTTP post routes. This is deliberately shared
 * rather than duplicated: the usual "don't abstract until the third repetition" rule is about
 * convenience helpers, and this is an authorization policy. Two copies of an access rule drift,
 * and when they do one transport allows exactly what the other forbids — which is the kind of
 * gap nobody notices until it is being exploited.
 *
 * The rule itself:
 *   - a DRAFT event is the host's private workspace — owner only
 *   - anything past draft is open to any authenticated user, which is what a public event
 *     link means
 *
 * Note this is a different question from `event.service.getEvent`, which is owner-only because
 * it exposes the host's full configuration. Being able to take part is not the same as being
 * able to see how the event is set up.
 */

/** True when this user may participate in (or watch) this event. */
function mayParticipate({ event, userId }) {
  if (!event) return false;
  if (event.status === 'draft') return event.owner.toString() === String(userId);
  return true;
}

/** Why not, in words a person can act on. Null when they may. */
function participationDenialReason({ event, userId }) {
  if (mayParticipate({ event, userId })) return null;
  return 'This event is not open yet.';
}

module.exports = { mayParticipate, participationDenialReason };
