/**
 * dashboard.routes.js — "what do I moderate?"
 *
 * Mounted at `/api/moderator` (singular), separate from `/api/moderators` (the invite/accept
 * routes) because this answers a question about the CALLER, not about an event's roster. No
 * `:userId` in the path — identity comes from the token, so there is nothing to tamper with.
 *
 * Deliberately no `requireRole` and no 403 for "you moderate nothing". An empty list is the
 * correct, successful answer for an attendee who has not been invited anywhere, and the frontend
 * uses exactly that to decide whether the Moderator area is available at all. Returning 403
 * instead would make "not a moderator yet" look identical to "something went wrong".
 */
const express = require('express');
const authMiddleware = require('../../shared/middlewares/auth.middleware');
const service = require('./dashboard.service');

const router = express.Router();

router.use(authMiddleware);

/**
 * GET /api/moderator/events
 *
 * Every event the caller may moderate — owned or invited — with pending workload and the
 * outcomes already settled on each.
 */
router.get('/events', async (req, res) => {
  const data = await service.getModeratedEvents(req.user.id);

  res.json({
    success: true,
    message: 'Moderated events fetched successfully.',
    data,
    errors: null,
  });
});

module.exports = router;
