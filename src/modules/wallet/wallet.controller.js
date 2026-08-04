/**
 * wallet.controller.js — the thin HTTP layer for the wallet.
 *
 * Reads from req.user (set by auth middleware) and req.validated (set by zodValidate), calls
 * the service, shapes the envelope. No business rules. Express 5 auto-catches async errors, so
 * no try/catch — same as event.controller.js.
 *
 * Only the dev grant is exposed. Balance reaches the frontend through the arena payload, and
 * an endpoint with no caller is exactly the defect that produced the moderator-count bug
 * earlier in this project.
 */
const walletService = require('./wallet.service');

// POST /api/wallet/grant  (development only — see wallet.routes.js and the mount in app.js)
async function grant(req, res) {
  const { amount } = req.validated;

  // The recipient is ALWAYS the authenticated caller. Even in a dev-only endpoint, crediting
  // an arbitrary userId from the body would be a habit worth not forming.
  const { balance } = await walletService.credit({
    userId: req.user.id,
    amount,
    type: 'grant',
  });

  return res.status(200).json({
    success: true,
    message: `Granted ${amount} tokens.`,
    data: { balance },
    errors: null,
  });
}

module.exports = { grant };
