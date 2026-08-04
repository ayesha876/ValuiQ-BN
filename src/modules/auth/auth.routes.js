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

// Brute-force guard for OTP VERIFICATION. A 6-digit code is only 1e6 wide, so
// without a limit an attacker could guess it fast — and a guessed reset OTP means
// account takeover. One shared limiter across both verify routes: attempts from a
// single IP to either endpoint count together (mirrors loginLimiter's window/cap).
// This is the IP layer; a per-account attempt counter in the service burns the
// specific code after too many wrong guesses (defence in depth).
const otpVerifyLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many attempts. Please try again in a few minutes.',
});

// Flood guard for REGISTRATION: each call creates an unverified account and sends
// an OTP email, so an unthrottled endpoint lets a script mass-create accounts /
// bomb inboxes. Cap set higher than login's 10 to leave headroom for shared-NAT
// bursts (e.g. many attendees signing up from one venue Wi-Fi) while still capping
// a flood to 20 new-account emails per IP per window.
const registerLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many sign-up attempts. Please try again in a few minutes.',
});

// Flood guard for OTP RE-SEND (registration resend + forgot-password): both "send
// me another code" actions email an OTP. One shared per-IP pool stops cross-account
// inbox-bombing; it composes with the existing 30s PER-ACCOUNT cooldown in the
// service (that caps one email address; this caps one IP across many addresses).
const resendLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many requests. Please try again in a few minutes.',
});

// Reusable email rule: must look like an email, then normalized to a trimmed,
// lowercase form so "A@X.com" and "a@x.com" are treated as the same account.
const emailRule = body('email')
  .isEmail()
  .withMessage('Enter a valid email address.')
  .bail()
  .customSanitizer((v) => v.trim().toLowerCase());

// POST /api/auth/register  { email, role }
// registerLimiter runs FIRST so a sign-up flood is shed per IP before we create a
// row or send an email.
router.post(
  '/register',
  registerLimiter,
  [
    emailRule,
    body('role').isIn(ROLES).withMessage('Please choose a valid role.'),
  ],
  validate,
  controller.register,
);

// POST /api/auth/verify-email  { email, otp }
// otpVerifyLimiter runs FIRST so brute-force guesses are throttled per IP before
// we ever hit the DB or compare a code.
router.post(
  '/verify-email',
  otpVerifyLimiter,
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
// resendLimiter runs FIRST (shared with forgot-password) to shed OTP-email floods
// per IP; the service's 30s per-account cooldown still applies on top.
router.post('/resend-otp', resendLimiter, [emailRule], validate, controller.resendOtp);

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
// resendLimiter runs FIRST (shared with resend-otp) to shed reset-OTP floods per IP;
// the service's 30s per-account silent throttle still applies on top.
router.post('/forgot-password', resendLimiter, [emailRule], validate, controller.forgotPassword);

// POST /api/auth/verify-reset-otp  { email, otp }  -> returns a short-lived reset token
// Same per-IP brute-force guard as verify-email — a guessed reset OTP is the most
// dangerous case (it yields a reset token), so it runs FIRST here too.
router.post(
  '/verify-reset-otp',
  otpVerifyLimiter,
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
