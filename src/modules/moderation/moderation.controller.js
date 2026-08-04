/**
 * moderation.controller.js — the thin HTTP layer for moderation decisions.
 *
 * Reads the request, calls the service, shapes the envelope. No business logic and no database
 * access, and no try/catch: Express 5 forwards a rejected async handler to the central error
 * handler on its own, which is why every other controller here omits it too.
 */
const moderationService = require('./moderation.service');

/**
 * POST /api/events/:eventId/moderation/decisions
 *
 * Applies Address / Dismiss / Neglect to one post. The moderator is taken from the verified
 * token, never the body — see the note in moderation.validation.js.
 *
 * 201 on a first application; 200 on a replayed retry, because nothing new was created — the
 * original decision is being reported back unchanged.
 *
 * @param {import('express').Request} req - `req.event` from requireEventModerator,
 *   `req.validated` from zodValidate, `req.user` from authMiddleware.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>} Sends `{ success, message, data: { post, decision, financials }, errors }`.
 */
async function createDecision(req, res) {
  const { postId, decision, reason } = req.validated;

  const outcome = await moderationService.applyDecision({
    event: req.event,
    postId,
    decision,
    moderatorId: req.user.id,
    reason,
    source: 'moderator',
  });

  const { replayed, ...body } = outcome;

  res.status(replayed ? 200 : 201).json({
    success: true,
    message: replayed ? 'This decision had already been applied.' : `Post ${body.post.status}.`,
    data: body,
    errors: null,
  });
}

/**
 * GET /api/events/:eventId/moderation/decisions
 *
 * The event's decision history, newest first — the audit trail for a host reviewing how their
 * event was moderated, including which posts the fairness timer settled for them.
 *
 * @param {import('express').Request} req - `req.validatedQuery` from zodValidate.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>} Sends `{ success, message, data: { decisions }, errors }`.
 */
async function listDecisions(req, res) {
  const decisions = await moderationService.getEventHistory(req.event.id, {
    limit: req.validatedQuery.limit,
  });

  res.json({
    success: true,
    message: 'Decisions fetched successfully.',
    data: { decisions },
    errors: null,
  });
}

module.exports = { createDecision, listDecisions };
