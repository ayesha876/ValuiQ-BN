/**
 * generateToken.js — creates and verifies the app's JSON Web Tokens (JWTs).
 *
 * There are TWO kinds of token in this app, and they are kept strictly separate:
 *
 *   1. LOGIN token  — proves "you are signed in". Full app access, longer expiry,
 *                     signed with JWT_SECRET.
 *   2. RESET token  — proves ONLY "you passed the password-reset OTP". It exists
 *                     for a few minutes and can do exactly one thing: authorize
 *                     POST /auth/reset-password. Signed with a DIFFERENT secret
 *                     (RESET_TOKEN_SECRET) and stamped with `purpose: 'reset'`.
 *
 * WHY two secrets: signing them with different keys means a reset token can never
 * be verified as a login token — and vice-versa — even if some code path mixed
 * them up. The `purpose` claim is a second, independent safety check. Never make
 * one usable in place of the other.
 */
const jwt = require('jsonwebtoken');
const config = require('../config/env');

/**
 * Sign a LOGIN token for a signed-in user.
 * The payload is deliberately tiny — just who they are (`sub`) and their role —
 * so nothing sensitive (never the password) travels inside the token.
 * @param {{ id?: string, _id?: any, role: string }} user
 * @returns {string} a signed JWT
 */
function signLoginToken(user) {
  const userId = String(user.id || user._id);
  return jwt.sign(
    { sub: userId, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );
}

/**
 * Sign a short-lived RESET token after a user proves ownership via the reset OTP.
 * Carries `purpose: 'reset'` so reset-password can confirm this token was issued
 * for exactly this job and nothing else.
 * @param {{ id?: string, _id?: any }} user
 * @returns {string} a signed, short-lived JWT
 */
function signResetToken(user) {
  const userId = String(user.id || user._id);
  return jwt.sign(
    { sub: userId, purpose: 'reset' },
    config.resetToken.secret,
    { expiresIn: config.resetToken.expiresIn },
  );
}

/**
 * Verify a RESET token. Returns the decoded payload if the token is genuine,
 * unexpired, AND actually a reset token. THROWS otherwise (bad signature, expired,
 * or wrong purpose) — the caller turns any throw into a 400 "start again".
 * @param {string} token
 * @returns {{ sub: string, purpose: string }}
 */
function verifyResetToken(token) {
  // jwt.verify throws on a bad signature or expiry — checked against the RESET
  // secret only, so a login token handed in here can never pass.
  const payload = jwt.verify(token, config.resetToken.secret);

  // Defence-in-depth: even a validly-signed token must say it's for resetting.
  if (payload.purpose !== 'reset') {
    throw new Error('Token is not a password-reset token.');
  }
  return payload;
}

/**
 * Verify a LOGIN token. Returns the decoded payload if the token is genuine and
 * unexpired; THROWS otherwise (bad signature / expired). Checked against the LOGIN
 * secret only, so a reset token handed in here can never pass. The auth middleware
 * turns any throw into a 401.
 * @param {string} token
 * @returns {{ sub: string, role: string }}
 */
function verifyLoginToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

module.exports = { signLoginToken, verifyLoginToken, signResetToken, verifyResetToken };
