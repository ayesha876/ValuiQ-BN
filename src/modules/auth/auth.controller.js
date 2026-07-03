/**
 * auth.controller.js — the thin HTTP layer.
 *
 * A controller's ONLY jobs: read what it needs from the request, call the
 * service, and shape the HTTP response. No business rules, no DB access. Every
 * handler is wrapped in try/catch and forwards errors to the central error
 * handler via next(err), so we never crash the process on a thrown error.
 *
 * Every response uses the same envelope so the frontend can rely on it:
 *   success -> { success: true,  message, data }
 *   failure -> { success: false, message }   (produced by the error handler)
 */
const authService = require('./auth.service');

// POST /api/auth/register  — body: { email, role }
async function register(req, res, next) {
  try {
    const { email, role } = req.body;
    const { user, resent } = await authService.register({ email, role });

    // Same 201 whether brand-new or a fresh code for an unverified returning
    // user — from the client's point of view, "a code is on its way".
    return res.status(201).json({
      success: true,
      message: resent
        ? 'A new verification code has been sent to your email.'
        : 'Registration successful. A verification code has been sent to your email.',
      data: { user },
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/verify-email  — body: { email, otp }
async function verifyEmail(req, res, next) {
  try {
    const { email, otp } = req.body;
    const { user, alreadyVerified } = await authService.verifyEmail({ email, otp });

    return res.status(200).json({
      success: true,
      message: alreadyVerified ? 'Email is already verified.' : 'Email verified successfully.',
      data: { user },
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/resend-otp  — body: { email }
async function resendOtp(req, res, next) {
  try {
    const { email } = req.body;
    const { user } = await authService.resendOtp({ email });

    return res.status(200).json({
      success: true,
      message: 'A new verification code has been sent to your email.',
      data: { user },
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/set-password  — body: { email, password }
async function setPassword(req, res, next) {
  try {
    const { email, password } = req.body;
    const { user } = await authService.setPassword({ email, password });

    return res.status(200).json({
      success: true,
      message: 'Password set successfully.',
      data: { user },
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/login  — body: { email, password }
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const { user, token } = await authService.login({ email, password });

    return res.status(200).json({
      success: true,
      message: 'Logged in successfully.',
      // The frontend saves `token` and routes by `user.role`.
      data: { token, user },
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/forgot-password  — body: { email }
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    // The service always returns the SAME neutral message, whether or not the
    // email exists — we just pass it straight through.
    const { message } = await authService.forgotPassword({ email });

    return res.status(200).json({
      success: true,
      message,
      data: null,
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/verify-reset-otp  — body: { email, otp }
async function verifyResetOtp(req, res, next) {
  try {
    const { email, otp } = req.body;
    const { resetToken } = await authService.verifyResetOtp({ email, otp });

    return res.status(200).json({
      success: true,
      message: 'Code verified.',
      // The frontend stores `resetToken` and sends it to /reset-password next.
      data: { resetToken },
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/reset-password  — body: { resetToken, newPassword }
async function resetPassword(req, res, next) {
  try {
    const { resetToken, newPassword } = req.body;
    const { user } = await authService.resetPassword({ resetToken, newPassword });

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully.',
      data: { user },
    });
  } catch (err) {
    return next(err);
  }
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
