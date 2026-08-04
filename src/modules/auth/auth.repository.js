/**
 * auth.repository.js — the ONLY file that talks to the User collection.
 *
 * WHY a repository: the service (business logic) should say WHAT it wants
 * ("find the user with this email") without knowing HOW it's stored (Mongoose
 * queries, which fields are hidden, etc.). If we ever change the DB or add
 * caching, only this file changes. Each function does one small DB job.
 */
const User = require('./auth.model');

// Create a brand-new user document.
function createUser(data) {
  return User.create(data);
}

// Find a user by email. By default the hidden fields (password, otp, ...) are
// NOT included — good for the common "does this email exist?" check.
function findByEmail(email) {
  return User.findOne({ email });
}

// Same lookup but ALSO pulls the normally-hidden OTP fields, for verification.
function findByEmailWithOtp(email) {
  return User.findOne({ email }).select('+otp +otpExpiry +otpAttempts +lastOtpSentAt');
}

// Same lookup but ALSO pulls the hidden password, for the set-password step and
// for LOGIN (where we need the hash to bcrypt-compare against).
function findByEmailWithPassword(email) {
  return User.findOne({ email }).select('+password');
}

// Pull the hidden RESET-OTP fields for the forgot-password / verify-reset-otp
// steps (the code, its expiry, and the last-sent time for the resend cooldown).
function findByEmailWithResetOtp(email) {
  return User.findOne({ email }).select(
    '+resetOtp +resetOtpExpiry +resetOtpAttempts +lastResetOtpSentAt',
  );
}

// Load a user by id, WITH the hidden password. Used by reset-password: the caller
// already knows the id (from the verified reset token) and needs the current hash
// to check the new password isn't identical to the old one.
function findByIdWithPassword(id) {
  return User.findById(id).select('+password');
}

// Load a user by id with only the default (public) fields — no hidden password/OTP.
// Used where only public fields are needed, e.g. the moderator-accept email match.
function findById(id) {
  return User.findById(id);
}

// Persist changes made to a user document we already loaded (runs pre-save
// hooks, e.g. password hashing).
function save(userDoc) {
  return userDoc.save();
}

module.exports = {
  createUser,
  findByEmail,
  findByEmailWithOtp,
  findByEmailWithPassword,
  findByEmailWithResetOtp,
  findByIdWithPassword,
  findById,
  save,
};
