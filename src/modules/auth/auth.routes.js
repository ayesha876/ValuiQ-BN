/**
 * auth.routes.js — declares the auth endpoints, their INPUT RULES, and which
 * controller handles each. This is the module's public surface.
 *
 * Order per route: [validation rules] -> validate middleware -> controller.
 * The rules + validate step guarantee the controller only ever runs on
 * well-formed input, so it (and the DB) never see garbage.
 */
const express = require('express');
const { body } = require('express-validator');

const validate = require('../../shared/middlewares/validate.middleware');
const rateLimiter = require('../../shared/middlewares/rateLimiter.middleware');
const authMiddleware = require('../../shared/middlewares/auth.middleware');
const controller = require('./auth.controller');
const { ROLES } = require('./auth.model');

const router = express.Router();

// Brute-force guard for the LOGIN route: at most 10 attempts per IP every 15
// minutes; the 11th gets a 429. Tuned to be invisible to normal users but to
// throttle password-guessing. (See rateLimiter.middleware.js for the store note.)
const loginLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again in a few minutes.',
});

// Reusable email rule: must look like an email, then normalized to a trimmed,
// lowercase form so "A@X.com" and "a@x.com" are treated as the same account.
const emailRule = body('email')
  .isEmail()
  .withMessage('Enter a valid email address.')
  .bail()
  .customSanitizer((v) => v.trim().toLowerCase());

// POST /api/auth/register  { email, role }
router.post(
  '/register',
  [
    emailRule,
    body('role').isIn(ROLES).withMessage('Please choose a valid role.'),
  ],
  validate,
  controller.register,
);

// POST /api/auth/verify-email  { email, otp }
router.post(
  '/verify-email',
  [
    emailRule,
    body('otp')
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage('Enter the 6-digit code.')
      .bail()
      .isNumeric()
      .withMessage('The code must be 6 digits.'),
  ],
  validate,
  controller.verifyEmail,
);

// POST /api/auth/resend-otp  { email }
router.post('/resend-otp', [emailRule], validate, controller.resendOtp);

// POST /api/auth/set-password  { password }  — authenticated first-time set only.
// authMiddleware runs FIRST so an unauthenticated request is rejected (401) before
// validation; identity comes from the token, never the body.
router.post(
  '/set-password',
  authMiddleware,
  [
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters.'),
  ],
  validate,
  controller.setPassword,
);

/* --- LOGIN (password only) --------------------------------------------- */

// POST /api/auth/login  { email, password }
// loginLimiter runs FIRST so brute-force attempts are blocked before we ever hit
// the DB or bcrypt. We only require the password to be present here (not 8+), so
// legacy/short passwords can still authenticate; length is enforced when SETTING
// a password, not when checking one.
router.post(
  '/login',
  loginLimiter,
  [
    emailRule,
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  validate,
  controller.login,
);

/* --- FORGOT / RESET PASSWORD (3 steps) --------------------------------- */

// POST /api/auth/forgot-password  { email }  -> sends a reset OTP (neutral reply)
router.post('/forgot-password', [emailRule], validate, controller.forgotPassword);

// POST /api/auth/verify-reset-otp  { email, otp }  -> returns a short-lived reset token
router.post(
  '/verify-reset-otp',
  [
    emailRule,
    body('otp')
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage('Enter the 6-digit code.')
      .bail()
      .isNumeric()
      .withMessage('The code must be 6 digits.'),
  ],
  validate,
  controller.verifyResetOtp,
);

// POST /api/auth/reset-password  { resetToken, newPassword }  -> sets the new password
router.post(
  '/reset-password',
  [
    body('resetToken').notEmpty().withMessage('Reset token is required.'),
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters.'),
  ],
  validate,
  controller.resetPassword,
);

module.exports = router;
