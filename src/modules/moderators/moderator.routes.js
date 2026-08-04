/**
 * moderator.routes.js — the moderator endpoints and their middleware pipelines.
 *
 * TWO routers, mounted separately in app.js:
 *   - eventModeratorRoutes: event-scoped, ORGANIZER + OWNER only. Mounted under
 *     /api/events/:eventId/moderators, so it uses { mergeParams:true } to read
 *     :eventId. Shared pipeline (router.use): authMiddleware ->
 *     requireRole('Event Organizer') -> requireEventOrganizer (owner check; loads
 *     req.event). Per-route extras (rate limit, body validation) run after.
 *   - moderatorRoutes: standalone, any authenticated user. Mounted at /api/moderators
 *     (the accept endpoint lands here in a later step).
 */
const express = require('express');

const authMiddleware = require('../../shared/middlewares/auth.middleware');
const requireRole = require('../../shared/middlewares/rbac.middleware');
const rateLimiter = require('../../shared/middlewares/rateLimiter.middleware');
const zodValidate = require('../../shared/middlewares/zodValidate.middleware');
const { requireEventOrganizer } = require('./moderator.middleware');
const controller = require('./moderator.controller');
const { inviteModeratorSchema, acceptInviteSchema } = require('./moderator.validation');

// Cap invites per IP so the endpoint (which writes rows + sends email) can't be
// spammed. Reuses the shared IP limiter as-is.
const inviteLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many invitations sent. Please try again in a few minutes.',
});

// --- Event-scoped (organizer + owner) ---
const eventModeratorRoutes = express.Router({ mergeParams: true });
eventModeratorRoutes.use(authMiddleware, requireRole('Event Organizer'), requireEventOrganizer);

// GET /api/events/:eventId/moderators — active members + pending invites (unified)
eventModeratorRoutes.get('/', controller.list);

// POST /api/events/:eventId/moderators/invite
eventModeratorRoutes.post(
  '/invite',
  inviteLimiter,
  zodValidate(inviteModeratorSchema),
  controller.invite,
);

// DELETE /api/events/:eventId/moderators/invites/:inviteId — cancel a pending invite.
// Registered before '/:memberId'; the two never collide (this is two path segments,
// '/:memberId' is one), but keeping the literal-prefixed route first is clearest.
eventModeratorRoutes.delete('/invites/:inviteId', controller.revokeInvite);

// DELETE /api/events/:eventId/moderators/:memberId — remove an active member.
eventModeratorRoutes.delete('/:memberId', controller.revokeMember);

// --- Standalone (any authenticated user) ---
const moderatorRoutes = express.Router();

// POST /api/moderators/accept — any authenticated user redeems an invite token.
// Guarded by auth only (not a role): the invited person may hold any global role.
moderatorRoutes.post('/accept', authMiddleware, zodValidate(acceptInviteSchema), controller.accept);

module.exports = { eventModeratorRoutes, moderatorRoutes };
