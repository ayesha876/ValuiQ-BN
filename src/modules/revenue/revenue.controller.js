/**
 * revenue.controller.js — the thin HTTP layer for host earnings.
 *
 * No try/catch (Express 5 forwards rejections), no database access, no business logic.
 */
const AppError = require('../../shared/utils/errors');
const revenueService = require('./revenue.service');

/**
 * Refuse to show one host another host's money.
 *
 * 403 rather than 404: unlike an event id, a user id is not a secret worth hiding — the caller
 * already knows their own, and a moderator can see the host of any event they work on. What
 * matters is that earnings are never disclosed, and a flat refusal says that plainly.
 *
 * There is no admin bypass because there is no admin role wired in this codebase yet
 * (`src/modules/admin/*` is still empty). When one lands, it belongs here.
 */
function assertOwnEarnings(req) {
  if (req.params.hostId !== req.user.id) {
    throw new AppError(403, 'You can only view your own earnings.');
  }
}

/**
 * GET /api/revenue/host/:hostId/summary
 *
 * Booked, pending, voided and paid totals, all in CENTS of real money — not tokens.
 *
 * @param {import('express').Request} req - `req.user` from authMiddleware.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>} Sends `{ success, message, data: { summary }, errors }`.
 */
async function getSummary(req, res) {
  assertOwnEarnings(req);
  const summary = await revenueService.getHostSummary(req.params.hostId);

  res.json({
    success: true,
    message: 'Earnings summary fetched successfully.',
    data: { summary },
    errors: null,
  });
}

/**
 * GET /api/revenue/host/:hostId/entries
 *
 * The individual entries behind the summary, newest first. Each carries its full calculation
 * (gross value, share, decision multiplier) so a host can see why a figure is what it is
 * without anyone re-deriving it — see the field comments in revenue.model.js.
 *
 * @param {import('express').Request} req - `req.validatedQuery` from zodValidate.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>} Sends `{ success, message, data: { entries }, errors }`.
 */
async function listEntries(req, res) {
  assertOwnEarnings(req);
  const entries = await revenueService.getHostEntries(req.params.hostId, {
    limit: req.validatedQuery.limit,
    status: req.validatedQuery.status ?? null,
  });

  res.json({
    success: true,
    message: 'Earnings entries fetched successfully.',
    data: { entries },
    errors: null,
  });
}

module.exports = { getSummary, listEntries };
