/**
 * attendee.routes.js — the attendee's own view of the platform.
 *
 * NOT event-scoped, and that is the point: these answer "what is MINE", so the resource is the
 * signed-in user. There is no `:userId` in any path — identity comes from the verified token and
 * nothing else, which makes the IDOR this module could have had structurally impossible rather
 * than merely checked for. (Compare `/api/revenue/host/:hostId/...`, which does take an id and
 * therefore needs an explicit ownership check in its controller.)
 *
 * No `requireRole` either. An Event Organizer testing their own event as a participant has a
 * wallet and a post history like anyone else, and locking them out here would only make the
 * product harder to demo. Every row returned is already scoped to the caller.
 */
const express = require('express');
const authMiddleware = require('../../shared/middlewares/auth.middleware');
const service = require('./attendee.service');

const router = express.Router();

router.use(authMiddleware);

/**
 * GET /api/attendee/events
 *
 * Events this attendee has taken part in, most recently started first.
 */
router.get('/events', async (req, res) => {
  const data = await service.getMyEvents(req.user.id);

  res.json({
    success: true,
    message: 'Your events fetched successfully.',
    data,
    errors: null,
  });
});

/**
 * GET /api/attendee/tokens
 *
 * The caller's token balance. TOKENS, not cents — the wallet's in-app currency.
 */
router.get('/tokens', async (req, res) => {
  const data = await service.getTokenBalance(req.user.id);

  res.json({
    success: true,
    message: 'Balance fetched successfully.',
    data,
    errors: null,
  });
});

module.exports = router;
