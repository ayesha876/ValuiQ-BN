/**
 * moderation.routes.js — URLs and the middleware pipeline for moderation decisions.
 *
 * ── TWO DEVIATIONS FROM THE WEEK 4 BRIEF, BOTH DELIBERATE ─────────────────────────────────
 *
 * 1. NOT `/api/v1/moderation/decisions`. This API is unversioned by an explicit earlier
 *    decision (VALUIQ_EVENTS_BACKEND_HANDOFF §5: "unversioned on purpose… migrate all routes
 *    to /api/v1 together only when a public/mobile client exists"). Adding `/v1` to one module
 *    would make it the only versioned path in the app — the inconsistency that decision exists
 *    to avoid. When versioning lands it lands everywhere, in one change.
 *
 * 2. EVENT-SCOPED, not flat. `/api/events/:eventId/moderation/decisions` rather than a global
 *    collection. Authorization here is per-event — a moderator on event A has no authority
 *    over event B — and that check needs the event in the path. A flat route would have to
 *    resolve the event from the post's body field before it could authorize, which means
 *    reading a post you may have no right to read in order to find out whether you may read
 *    it. Putting the event in the URL keeps the guard ahead of the data, exactly as
 *    `/api/events/:eventId/moderators` already does.
 *
 * `mergeParams: true` because `:eventId` belongs to the mount path in app.js, not to this
 * router — without it `req.params.eventId` is undefined and the guard fails open on a lookup
 * for `undefined`.
 */
const express = require('express');
const authMiddleware = require('../../shared/middlewares/auth.middleware');
const zodValidate = require('../../shared/middlewares/zodValidate.middleware');
const rateLimiter = require('../../shared/middlewares/rateLimiter.middleware');
const { requireEventModerator } = require('../moderators/moderator.middleware');
const { createDecisionSchema, decisionHistoryQuerySchema } = require('./moderation.validation');
const controller = require('./moderation.controller');

const router = express.Router({ mergeParams: true });

/**
 * A generous cap: a moderator working through a busy queue legitimately makes a decision every
 * few seconds, so this is an abuse guard rather than a pace limit. Deliberately looser than the
 * invite limiter (20/15min) — an invite sends an email to a third party, a decision does not.
 */
const decisionLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many moderation decisions in a short time. Please slow down.',
});

/**
 * Applied once, to everything below, so a route added later cannot forget a guard — the same
 * `router.use` discipline as moderator.routes.js.
 *
 * `requireEventModerator` (built during Week 1 and wired to nothing until now) allows the event
 * OWNER or an ACTIVE EventMember. Note there is deliberately NO `requireRole` here: an event
 * moderator may hold any global role, and gating on the vestigial global 'Moderator' role would
 * lock out every moderator who registered as an Attendee — which is most of them.
 */
router.use(authMiddleware, requireEventModerator);

router.post(
  '/decisions',
  decisionLimiter,
  zodValidate(createDecisionSchema),
  controller.createDecision,
);

router.get(
  '/decisions',
  zodValidate(decisionHistoryQuerySchema, 'query'),
  controller.listDecisions,
);

module.exports = router;
