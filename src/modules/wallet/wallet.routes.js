/**
 * wallet.routes.js — ⚠️ DEVELOPMENT-ONLY routes.
 *
 * Attendees cannot buy tokens until Stripe lands in Week 5, but posting and voting need a
 * balance to spend NOW — for demos and for the concurrent-user stress test. This grant fills
 * that gap and is meant to stop existing the moment purchases are real.
 *
 * TWO INDEPENDENT GUARDS, deliberately:
 *   1. app.js only mounts this router when NODE_ENV !== 'production'.
 *   2. The guard below refuses every request in production even if it somehow got mounted.
 *
 * Belt and braces is proportionate here: the failure mode is an endpoint that mints currency.
 * One guard is one edit away from being removed by someone who does not know what it protects.
 */
const express = require('express');

const config = require('../../shared/config/env');
const AppError = require('../../shared/utils/errors');
const authMiddleware = require('../../shared/middlewares/auth.middleware');
const rateLimiter = require('../../shared/middlewares/rateLimiter.middleware');
const zodValidate = require('../../shared/middlewares/zodValidate.middleware');
const controller = require('./wallet.controller');
const { grantTokensSchema } = require('./wallet.validation');

const router = express.Router();

// Guard 2 — refuse outright in production, regardless of how this router got mounted.
router.use((req, res, next) => {
  if (config.isProduction) {
    return next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
  }
  return next();
});

// Generous, since a load test may fund many accounts in a burst — but still bounded, so a
// runaway script cannot hammer this indefinitely.
const grantLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Too many token grants. Please try again in a few minutes.',
});

// Any signed-in role may fund themselves in development: an Event Organizer testing their own
// event as an attendee needs tokens too, and role rules here would only get in the way.
router.use(authMiddleware);

// POST /api/wallet/grant — credit the authenticated caller.
router.post('/grant', grantLimiter, zodValidate(grantTokensSchema), controller.grant);

module.exports = router;
