/**
 * post.routes.js — the attendee and moderator endpoints for posts.
 *
 * MOUNTING: both routers attach under `/api/events/:eventId/...` and MUST be mounted before
 * `/api/events` in app.js. The events router applies `requireRole('Event Organizer')` to
 * everything beneath it, and attendees are not organizers — mounting after it would 403 every
 * attendee. Same reason, and the same fix, as the moderator routes.
 *
 * Two guards, because two audiences:
 *   requireEventParticipant — any authenticated user (a draft stays private to its owner)
 *   requireEventModerator   — the organizer, or an active moderator of this event
 */
const express = require('express');

const authMiddleware = require('../../shared/middlewares/auth.middleware');
const rateLimiter = require('../../shared/middlewares/rateLimiter.middleware');
const zodValidate = require('../../shared/middlewares/zodValidate.middleware');
const { requireEventParticipant } = require('../events/event.middleware');
const { requireEventModerator } = require('../moderators/moderator.middleware');
const controller = require('./post.controller');
const { createPostSchema, reviewPostSchema } = require('./post.validation');

// The REAL brake on posting is the wallet: every post costs tokens, so nobody can post
// meaningfully faster than they can fund it. This is only an anti-hammering ceiling for a
// broken or malicious client — set well above anything a person could afford to do, and keyed
// per user rather than per IP so a venue full of attendees on one wifi is not treated as one
// caller. See rateLimiter.middleware.js.
const createLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'You are posting too quickly. Please wait a moment.',
});

// --- Attendee: GET /api/events/:eventId/arena ------------------------------
const arenaRoutes = express.Router({ mergeParams: true });
arenaRoutes.use(authMiddleware, requireEventParticipant);
arenaRoutes.get('/', controller.arena);

// --- Attendee: GET /api/events/:eventId/feed -------------------------------
const feedRoutes = express.Router({ mergeParams: true });
feedRoutes.use(authMiddleware, requireEventParticipant);
feedRoutes.get('/', controller.feed);

// --- Posts: /api/events/:eventId/posts -------------------------------------
const postRoutes = express.Router({ mergeParams: true });
postRoutes.use(authMiddleware);

// The moderator queue sits at /posts/queue, so it must be declared BEFORE any /:postId route
// would be able to swallow it. There is no such route today; declaring it first keeps it safe
// if one is ever added.
postRoutes.get('/queue', requireEventModerator, controller.queue);

postRoutes.patch(
  '/:postId/review',
  requireEventModerator,
  zodValidate(reviewPostSchema),
  controller.review,
);

postRoutes.post('/', createLimiter, requireEventParticipant, zodValidate(createPostSchema), controller.create);

module.exports = { arenaRoutes, feedRoutes, postRoutes };
