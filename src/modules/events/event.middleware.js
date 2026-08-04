/**
 * event.middleware.js — event-scoped guards for attendee-facing routes.
 *
 * Mirrors moderator.middleware.js in shape (404 for missing, 403 for not-allowed, the loaded
 * event attached to req.event so nothing downstream reloads it) but answers a different
 * question: not "do you own this event?" but "may you take part in it?".
 *
 * The rule itself lives in event.access.js, shared with the Socket.IO handshake, so the HTTP
 * and realtime paths can never disagree about who is allowed into an event.
 */
const AppError = require('../../shared/utils/errors');
const eventRepo = require('./event.repository');
const { participationDenialReason } = require('./event.access');

async function requireEventParticipant(req, res, next) {
  const event = await eventRepo.findActiveById(req.params.eventId);
  // Soft-deleted reads as not-found, exactly as it does everywhere else.
  if (!event) return next(new AppError(404, 'Event not found.'));

  const denial = participationDenialReason({ event, userId: req.user.id });
  if (denial) return next(new AppError(403, denial));

  req.event = event;
  return next();
}

module.exports = { requireEventParticipant };
