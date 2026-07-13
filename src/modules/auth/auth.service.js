/**
 * auth.service.js — the BUSINESS LOGIC for registration (Flow A).
 *
 * This layer decides WHAT should happen (the rules), and calls the repository
 * for anything that touches the database. It never uses req/res (that's the
 * controller's job) and never writes Mongoose queries directly (that's the
 * repository's job). Each exported function maps to one endpoint.
 */
const bcrypt = require('bcrypt');
const config = require('../../shared/config/env');
const AppError = require('../../shared/utils/errors');
const generateOtp = require('../../shared/utils/generateOtp');
const { signLoginToken, signResetToken, verifyResetToken } = require('../../shared/utils/generateToken');
const {
  sendVerificationEmail,
  sendResetPasswordEmail,
} = require('../../integrations/mailer/mailer.client');
const repo = require('./auth.repository');

// --- Timings (all derived from config where sensible) ---
const OTP_TTL_MS = config.otpExpiryMinutes * 60 * 1000; // how long a code is valid
const GHOST_TTL_MS = 24 * 60 * 60 * 1000; // unverified account auto-delete window
const RESEND_COOLDOWN_MS = 30 * 1000; // min gap between resend requests

// Password-reset timings (separate from registration OTP above).
const RESET_OTP_TTL_MS = config.resetOtpExpiryMinutes * 60 * 1000;
const RESET_RESEND_COOLDOWN_MS = 30 * 1000; // min gap between reset-OTP sends

// Max consecutive WRONG OTP guesses allowed against a single code before it is
// BURNED (cleared) and the user must request a fresh one. Stops a 6-digit code
// from being brute-forced. Applies identically to verify-email and verify-reset-otp.
const MAX_OTP_ATTEMPTS = 5;

// The ONE neutral reply forgot-password ever gives, whether or not the email
// exists. Identical wording + status in both cases is what stops an attacker from
// discovering which emails are registered (email-enumeration).
const NEUTRAL_FORGOT_MESSAGE = 'If this email is registered, an OTP has been sent.';

// The ONE generic reply login gives for a bad email OR a bad password — same
// reason: never reveal whether an email exists.
const GENERIC_LOGIN_ERROR = 'Invalid email or password.';

/**
 * Build a fresh OTP + its expiry + the "sent at" timestamp. Returned as plain
 * values so both the create-new and update-existing paths can reuse it.
 */
function issueOtp() {
  const now = Date.now();
  return {
    otp: generateOtp(),
    otpExpiry: new Date(now + OTP_TTL_MS),
    lastOtpSentAt: new Date(now),
    // A fresh code always starts with a clean guess counter.
    otpAttempts: 0,
  };
}

/**
 * "Send" the OTP. In development we ALSO print it to the console so the whole
 * flow is testable with no real inbox. A send failure is fatal in production but
 * ignored in dev (the console OTP is enough to keep testing).
 */
async function deliverOtp(email, otp) {
  if (!config.isProduction) {
    console.log(`\n[DEV OTP] ${email} -> ${otp} (valid ${config.otpExpiryMinutes} min)\n`);
  }
  try {
    await sendVerificationEmail({ to: email, otp });
  } catch (err) {
    if (config.isProduction) throw err;
    console.warn('[mailer] Dev send failed — use the console OTP above:', err.message);
  }
}

/**
 * "Send" the RESET OTP. Same dev-friendly behaviour as deliverOtp: in development
 * the code is printed to the console so the whole reset flow is testable with no
 * real inbox, and a send failure is non-fatal in dev but fatal in production.
 */
async function deliverResetOtp(email, otp) {
  if (!config.isProduction) {
    console.log(`\n[DEV RESET OTP] ${email} -> ${otp} (valid ${config.resetOtpExpiryMinutes} min)\n`);
  }
  try {
    await sendResetPasswordEmail({ to: email, otp });
  } catch (err) {
    if (config.isProduction) throw err;
    console.warn('[mailer] Dev send failed — use the console reset OTP above:', err.message);
  }
}

/**
 * STEP 1 — Register (email + role).
 * - Verified email already taken  -> 409.
 * - Unverified email exists        -> refresh + resend OTP (no error).
 * - New email                      -> create unverified user with an OTP.
 * @returns {{ user, resent: boolean }}
 */
async function register({ email, role }) {
  const existing = await repo.findByEmail(email);

  if (existing && existing.isVerified) {
    throw new AppError(409, 'Email already registered.');
  }

  const { otp, otpExpiry, lastOtpSentAt, otpAttempts } = issueOtp();
  let user;
  let resent = false;

  if (existing) {
    // Returning user who never verified (refreshed/came back). Refresh their
    // code, role choice, and the 24h cleanup window; do NOT treat it as an error.
    existing.role = role;
    existing.otp = otp;
    existing.otpExpiry = otpExpiry;
    existing.otpAttempts = otpAttempts; // fresh code → clean guess counter
    existing.lastOtpSentAt = lastOtpSentAt;
    existing.expiresAt = new Date(Date.now() + GHOST_TTL_MS);
    user = await repo.save(existing);
    resent = true;
  } else {
    user = await repo.createUser({
      email,
      role,
      isVerified: false,
      hasPassword: false,
      otp,
      otpExpiry,
      otpAttempts,
      lastOtpSentAt,
      expiresAt: new Date(Date.now() + GHOST_TTL_MS),
    });
  }

  await deliverOtp(user.email, otp);
  return { user, resent };
}

/**
 * STEP 2 — Verify email with the OTP.
 * Marks the account active and clears the code so it can't be reused.
 * @returns {{ user, alreadyVerified: boolean }}
 */
async function verifyEmail({ email, otp }) {
  const user = await repo.findByEmailWithOtp(email);
  if (!user) throw new AppError(404, 'No account found for this email.');

  // Already done — tell the caller, don't re-run verification.
  if (user.isVerified) return { user, alreadyVerified: true };

  if (!user.otp || !user.otpExpiry) {
    throw new AppError(400, 'No active code. Please request a new one.');
  }
  if (user.otpExpiry.getTime() < Date.now()) {
    throw new AppError(400, 'Code expired, please request a new one.');
  }
  if (user.otp !== otp) {
    // Wrong guess: count it, and once too many pile up BURN the code (clear it)
    // so a 6-digit OTP can't be brute-forced — the user must request a new one.
    user.otpAttempts = (user.otpAttempts || 0) + 1;
    if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
      user.otp = undefined;
      user.otpExpiry = undefined;
      user.otpAttempts = 0;
      await repo.save(user);
      throw new AppError(400, 'Too many incorrect attempts. Please request a new code.');
    }
    await repo.save(user);
    throw new AppError(400, 'Invalid code.');
  }

  // Success: activate the account and wipe the temporary fields. Unsetting
  // `expiresAt` removes the TTL timer, making the account permanent.
  user.isVerified = true;
  user.otp = undefined;
  user.otpExpiry = undefined;
  user.otpAttempts = 0;
  user.lastOtpSentAt = undefined;
  user.expiresAt = undefined;
  const saved = await repo.save(user);

  // OTP proven → this IS the authentication event, so issue the login session
  // token here (reuses signLoginToken). Carries BOTH Flow A and Flow B users
  // straight to the dashboard. NOTE: only the fresh-verification path mints a
  // token — the already-verified branch above returns no token, unchanged.
  const token = signLoginToken(saved);
  return { user: saved, alreadyVerified: false, token };
}

/**
 * Resend a fresh OTP to an unverified user, with a simple cooldown so the
 * endpoint can't be spammed.
 * @returns {{ user }}
 */
async function resendOtp({ email }) {
  const user = await repo.findByEmailWithOtp(email);
  if (!user) throw new AppError(404, 'No account found for this email.');
  if (user.isVerified) throw new AppError(400, 'This email is already verified.');

  if (user.lastOtpSentAt) {
    const elapsed = Date.now() - user.lastOtpSentAt.getTime();
    if (elapsed < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      throw new AppError(429, `Please wait ${waitSec}s before requesting another code.`);
    }
  }

  const { otp, otpExpiry, lastOtpSentAt, otpAttempts } = issueOtp();
  user.otp = otp;
  user.otpExpiry = otpExpiry;
  user.otpAttempts = otpAttempts; // fresh code → clean guess counter
  user.lastOtpSentAt = lastOtpSentAt;
  user.expiresAt = new Date(Date.now() + GHOST_TTL_MS); // refresh cleanup window
  await repo.save(user);

  await deliverOtp(user.email, otp);
  return { user };
}

/**
 * STEP 3 — Set a password (optional; Continue button).
 * Only allowed once the email is verified. The confirm-match is a frontend UX
 * check; the 8-char minimum is re-enforced on the backend via the route validator.
 * @returns {{ user }}
 */
async function setPassword({ userId, password }) {
  const user = await repo.findByIdWithPassword(userId);
  if (!user) throw new AppError(401, 'Please log in again.');
  if (!user.isVerified) {
    throw new AppError(403, 'Please verify your email before setting a password.');
  }

  // First-time only: a user who already has a password must go through the reset
  // chain (Forgot Password). This path must NEVER overwrite an existing password.
  if (user.hasPassword) {
    throw new AppError(403, 'Password already set. Use Forgot Password to change it.');
  }

  // NOTE: future place for a password strength / breach-history check. For MVP
  // we only enforce the 8-char minimum (done in the route validator).
  user.password = password; // the model's pre-save hook hashes this
  user.hasPassword = true;
  const saved = await repo.save(user);
  return { user: saved };
}

/* ==========================================================================
 * LOGIN  (password only — no OTP login)
 * ======================================================================== */

/**
 * LOGIN — verify an email + password and, on success, mint a login JWT.
 *
 * The checks run in a deliberate order, and all "user problem" answers are
 * intentionally GENERIC so an attacker can't tell a real email from a fake one:
 *   - no such user            -> 401 generic
 *   - user exists, unverified -> 403 "verify your email first"
 *   - user exists, NO password (a "Skip" user) -> 403 pointing them to reset
 *   - password set but wrong  -> 401 (SAME generic message as "no such user")
 * @returns {{ user, token }}
 */
async function login({ email, password }) {
  // Load the user WITH the hidden hash so we can bcrypt-compare.
  const user = await repo.findByEmailWithPassword(email);

  // Unknown email → generic 401. Same message as a wrong password (below).
  if (!user) throw new AppError(401, GENERIC_LOGIN_ERROR);

  // Known but not yet verified → they must finish email verification first.
  if (!user.isVerified) {
    throw new AppError(403, 'Please verify your email first.');
  }

  // Known + verified but never set a password (used the "Skip" button at signup).
  // They CAN'T log in with a password — point them at Forgot Password, which for
  // these users is how they create their first password.
  if (!user.password) {
    throw new AppError(
      403,
      'No password set for this account. Use Forgot Password to create one.',
    );
  }

  // Compare the submitted password against the stored bcrypt hash.
  const passwordMatches = await bcrypt.compare(password, user.password);
  if (!passwordMatches) throw new AppError(401, GENERIC_LOGIN_ERROR);

  // Success → issue the LOGIN token (full app access). The `user` doc is safe to
  // return: toJSON strips the password/hash and all OTP fields automatically.
  const token = signLoginToken(user);
  return { user, token };
}

/* ==========================================================================
 * FORGOT / RESET PASSWORD  (3 steps: request OTP -> verify OTP -> set password)
 * Also doubles as "set your FIRST password" for users who skipped it at signup.
 * ======================================================================== */

/**
 * STEP 1 — Request a reset OTP.
 *
 * ALWAYS resolves with the same neutral message (see NEUTRAL_FORGOT_MESSAGE) so
 * the caller can't learn whether the email exists. Only if the user really exists
 * do we actually generate + send a code. A silent time-based throttle stops the
 * endpoint being used to spam someone's inbox — and it's SILENT (still returns the
 * neutral message) precisely so throttling can't be used to detect real emails.
 * @returns {{ message: string }}
 */
async function forgotPassword({ email }) {
  const user = await repo.findByEmailWithResetOtp(email);

  // No account → do nothing, but answer exactly the same as the success case.
  if (!user) return { message: NEUTRAL_FORGOT_MESSAGE };

  // Throttle: if we sent a code very recently, skip sending again — but STILL
  // return the neutral message (never reveal the throttle to the caller).
  if (user.lastResetOtpSentAt) {
    const elapsed = Date.now() - user.lastResetOtpSentAt.getTime();
    if (elapsed < RESET_RESEND_COOLDOWN_MS) {
      return { message: NEUTRAL_FORGOT_MESSAGE };
    }
  }

  // Generate a fresh reset code + expiry, store it, and send it.
  const now = Date.now();
  user.resetOtp = generateOtp();
  user.resetOtpExpiry = new Date(now + RESET_OTP_TTL_MS);
  user.resetOtpAttempts = 0; // fresh code → clean guess counter
  user.lastResetOtpSentAt = new Date(now);
  await repo.save(user);

  await deliverResetOtp(user.email, user.resetOtp);
  return { message: NEUTRAL_FORGOT_MESSAGE };
}

/**
 * STEP 2 — Verify the reset OTP.
 *
 * On success we DON'T just say "ok". We hand back a short-lived reset TOKEN and
 * immediately clear the code. That token is what authorizes step 3 — so nobody
 * can call reset-password directly without first proving they own the email by
 * passing this OTP. All failure answers are a plain 400 so a wrong email looks
 * exactly like a wrong code (no enumeration).
 * @returns {{ resetToken: string }}
 */
async function verifyResetOtp({ email, otp }) {
  const user = await repo.findByEmailWithResetOtp(email);

  // Unknown email OR no active code → treat as an invalid code (don't reveal which).
  if (!user || !user.resetOtp || !user.resetOtpExpiry) {
    throw new AppError(400, 'Invalid code.');
  }
  if (user.resetOtpExpiry.getTime() < Date.now()) {
    throw new AppError(400, 'Code expired, request a new one.');
  }
  if (user.resetOtp !== otp) {
    // Wrong guess: count it, and once too many pile up BURN the reset code so it
    // can't be brute-forced into a reset token — the user must request a new one.
    user.resetOtpAttempts = (user.resetOtpAttempts || 0) + 1;
    if (user.resetOtpAttempts >= MAX_OTP_ATTEMPTS) {
      user.resetOtp = undefined;
      user.resetOtpExpiry = undefined;
      user.resetOtpAttempts = 0;
      await repo.save(user);
      throw new AppError(400, 'Too many incorrect attempts. Please request a new code.');
    }
    await repo.save(user);
    throw new AppError(400, 'Invalid code.');
  }

  // Correct code → mint the reset token BEFORE clearing, then wipe the OTP so the
  // same code can never be used twice.
  const resetToken = signResetToken(user);
  user.resetOtp = undefined;
  user.resetOtpExpiry = undefined;
  user.resetOtpAttempts = 0;
  user.lastResetOtpSentAt = undefined;
  await repo.save(user);

  return { resetToken };
}

/**
 * STEP 3 — Set the new password, authorized by the reset token from step 2.
 *
 * This is the SAME endpoint whether the user is changing an existing password or
 * setting their very first one (a "Skip" user) — it never requires an old
 * password. Passing the OTP already proved they own the email, so we also mark the
 * account verified here.
 * @returns {{ user }}
 */
async function resetPassword({ resetToken, newPassword }) {
  // 1) The token must be genuine, unexpired, and actually a reset token. Any
  //    failure (bad signature / expired / wrong purpose) means "start over".
  let payload;
  try {
    payload = verifyResetToken(resetToken);
  } catch (err) {
    throw new AppError(400, 'Reset session expired, please start again.');
  }

  // 2) Load the user named in the token (WITH the current hash, needed below).
  const user = await repo.findByIdWithPassword(payload.sub);
  if (!user) throw new AppError(400, 'Reset session expired, please start again.');

  // 3) Re-check the length on the backend (the route validator also enforces it;
  //    this is defence in depth — never trust that validation ran).
  if (!newPassword || newPassword.length < 8) {
    throw new AppError(400, 'Password must be at least 8 characters.');
  }

  // 4) Light "not the same as before" check the screen hints at. If the user
  //    already has a password, reject re-using the identical one. This is NOT a
  //    full password-history/breach system — that would live here later (compare
  //    against a stored list of previous hashes / a breach API).
  if (user.password) {
    const sameAsCurrent = await bcrypt.compare(newPassword, user.password);
    if (sameAsCurrent) {
      throw new AppError(400, 'New password must be different from your current password.');
    }
  }

  // 5) Save. Setting `password` triggers the model's pre-save hook, which hashes
  //    it — a plain-text password is never stored.
  user.password = newPassword;
  user.hasPassword = true;
  user.isVerified = true; // passing the OTP proves they own this email
  user.expiresAt = undefined; // if they were an unverified "ghost", make permanent
  user.resetOtp = undefined; // belt-and-suspenders: clear any leftover reset state
  user.resetOtpExpiry = undefined;
  user.lastResetOtpSentAt = undefined;
  const saved = await repo.save(user);

  // Mirror of verify-email: the reset OTP already proved ownership, so auto-login
  // the user (reuses signLoginToken) instead of forcing a separate manual login
  // after a returning passwordless user uses "Set Password".
  const token = signLoginToken(saved);
  return { user: saved, token };
}

module.exports = {
  register,
  verifyEmail,
  resendOtp,
  setPassword,
  login,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
};
