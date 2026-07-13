/**
 * moderator.middleware.js — event-scoped authorization guards for the moderator
 * routes (and, later, Posts/Moderation).
 *
 * Both guards run AFTER authMiddleware (which sets req.user) and mirror the events
 * module's IDOR discipline: a missing event is 404, an event that exists but isn't
 * the caller's is 403. They load the event through the EXISTING event repository so
 * "which events are reachable" can never drift from the events module — reusing
 * findActiveById also means soft-deleted events are treated as not-found, while any
 * live status (draft/scheduled/live/ended) is fine (it's deletedAt-gated, not
 * status-gated).
 *
 * The loaded event is attached to req.event so the controller/service doesn't reload it.
 */
const AppError = require('../../shared/utils/errors');
const eventRepo = require('../events/event.repository');
const moderatorRepo = require('./moderator.repository');

/**
 * requireEventOrganizer — the caller must OWN the event named by :eventId.
 * Used by invite / list / revoke (all organizer-only, owner-scoped).
 */
async function requireEventOrganizer(req, res, next) {
  const event = await eventRepo.findActiveById(req.params.eventId);
  if (!event) {
    return next(new AppError(404, 'Event not found.'));
  }
  if (event.owner.toString() !== req.user.id) {
    return next(new AppError(403, 'You do not have permission to manage this event.'));
  }
  req.event = event;
  return next();
}

/**
 * requireEventModerator — forward-looking guard for the future Posts/Moderation
 * modules: the caller may act on the event if they OWN it (organizer) OR they are an
 * ACTIVE moderator member of it. Implemented in full now; wired to no route yet, so
 * it can't affect anything live.
 */
async function requireEventModerator(req, res, next) {
  const event = await eventRepo.findActiveById(req.params.eventId);
  if (!event) {
    return next(new AppError(404, 'Event not found.'));
  }

  // The organizer always has moderator authority over their own event.
  if (event.owner.toString() === req.user.id) {
    req.event = event;
    return next();
  }

  // Otherwise, an ACTIVE membership is required (revoked ones don't count).
  const isActiveMember = await moderatorRepo.existsActiveMembership({
    userId: req.user.id,
    eventId: event.id,
  });
  if (!isActiveMember) {
    return next(new AppError(403, 'You do not have permission to moderate this event.'));
  }

  req.event = event;
  return next();
}

module.exports = { requireEventOrganizer, requireEventModerator };
