/**
 * vote.routes.js — backing a post with tokens.
 *
 * Mounted at /api/events/:eventId/posts/:postId/votes, BEFORE /api/events for the same reason
 * as the post routes: the events router is Event-Organizer-only, and voting is what attendees
 * do. `mergeParams` is what makes :eventId and :postId visible here.
 */
const express = require('express');

const authMiddleware = require('../../shared/middlewares/auth.middleware');
const rateLimiter = require('../../shared/middlewares/rateLimiter.middleware');
const zodValidate = require('../../shared/middlewares/zodValidate.middleware');
const { requireEventParticipant } = require('../events/event.middleware');
const controller = require('./vote.controller');
const { castVoteSchema } = require('./vote.validation');

const router = express.Router({ mergeParams: true });

// As with posting, the wallet is the real brake — every vote costs tokens. This is only an
// anti-hammering ceiling, and it is keyed per USER, so a venue full of attendees sharing one
// wifi is not throttled as though it were a single caller.
const voteLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'You are voting too quickly. Please wait a moment.',
});

router.post('/', authMiddleware, voteLimiter, requireEventParticipant, zodValidate(castVoteSchema), controller.cast);

module.exports = router;
