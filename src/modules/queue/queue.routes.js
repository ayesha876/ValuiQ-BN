/**
 * queue.routes.js — the review queue endpoint.
 *
 * Event-scoped and moderator-guarded for the same reason as moderation.routes.js: the queue
 * exposes every undecided post in an event along with the money riding on each, which is
 * exactly what an attendee must not see. `requireEventModerator` allows the event owner or an
 * active EventMember.
 *
 * Validation and the controller live here rather than in separate files: the module is one
 * endpoint, and three files to serve one route is structure for its own sake. The house rule
 * is many small FOCUSED files, not many files.
 */
const express = require('express');
const { z } = require('zod');
const authMiddleware = require('../../shared/middlewares/auth.middleware');
const zodValidate = require('../../shared/middlewares/zodValidate.middleware');
const { requireEventModerator } = require('../moderators/moderator.middleware');
const queueService = require('./queue.service');

const router = express.Router({ mergeParams: true });

/**
 * Query for `GET /api/events/:eventId/queue/review`.
 *
 * `.strict()`, so an unknown param is a 400 rather than a silently ignored filter — a moderator
 * who mistypes `staus=FLAGGED` should be told, not shown an unfiltered queue they believe is
 * filtered.
 *
 * The upper bound on `limit` mirrors the events list (max 50): a client cannot ask for a page
 * large enough to strain the server, and every row here costs a valuation.
 */
const reviewQueueQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    sortBy: z.enum(['flaggedAt', 'severity']).default('severity'),
    status: z.enum(['FLAGGED', 'ALL']).default('FLAGGED'),
  })
  .strict();

router.use(authMiddleware, requireEventModerator);

/**
 * GET /api/events/:eventId/queue/review
 *
 * The ordered review queue. Default ordering is severity DESC then oldest-first, which is
 * "most urgent, longest-waiting" — see queue.service.js for how severity is derived.
 *
 * @param {import('express').Request} req - `req.event` from requireEventModerator.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>} Sends `{ success, message, data: { items, pagination }, errors }`.
 */
async function getReviewQueue(req, res) {
  const { page, limit, sortBy, status } = req.validatedQuery;

  const result = await queueService.getReviewQueue({ event: req.event, page, limit, sortBy, status });

  res.json({
    success: true,
    message: 'Review queue fetched successfully.',
    data: result,
    errors: null,
  });
}

router.get('/review', zodValidate(reviewQueueQuerySchema, 'query'), getReviewQueue);

module.exports = router;
