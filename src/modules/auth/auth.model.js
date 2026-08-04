/**
 * auth.model.js — the User schema (the shape of a user document in MongoDB).
 *
 * This is the "model" layer: it ONLY describes data + data-level rules (types,
 * required, unique, how the password gets hashed before saving). No business
 * logic and no request handling live here.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const config = require('../../shared/config/env');

// The only roles a user may have. Kept as the exact strings the frontend sends
// so no translation is needed between the two repos.
const ROLES = ['Event Organizer', 'Moderator', 'Attendee'];

const userSchema = new mongoose.Schema(
  {
    // Login identity. UNIQUE so two accounts can never share an email; the unique
    // index also makes "find user by email" fast even at 1000s+ of users.
    email: {
      type: String,
      required: [true, 'Email is required.'],
      unique: true,
      lowercase: true, // stored lowercased so lookups are case-insensitive
      trim: true,
    },

    // Which kind of user this is. Restricted to the three known roles.
    role: {
      type: String,
      required: [true, 'Role is required.'],
      enum: { values: ROLES, message: 'Invalid role selected.' },
    },

    // NOT required on purpose: the "Set A Password" screen has a Skip button, so
    // a verified account may legitimately have no password. `select: false` means
    // the hash is never loaded/returned unless a query explicitly asks for it.
    password: {
      type: String,
      select: false,
    },

    // Convenience flag so other code can tell "verified but skipped password"
    // apart without loading the (hidden) password hash.
    hasPassword: {
      type: Boolean,
      default: false,
    },

    // The account becomes "active" once the email OTP is confirmed.
    isVerified: {
      type: Boolean,
      default: false,
    },

    // The current 6-digit code + when it stops being valid. Both are hidden from
    // normal queries and are CLEARED the moment the user verifies, so a code can
    // never be reused.
    otp: { type: String, select: false },
    otpExpiry: { type: Date, select: false },

    // Counts consecutive WRONG verify-email attempts against the current code.
    // Once it hits the max the code is burned (cleared) so a 6-digit OTP can't be
    // brute-forced; reset to 0 whenever a fresh code is issued or on success.
    otpAttempts: { type: Number, default: 0, select: false },

    // Powers the simple "don't resend too fast" guard. Hidden from responses.
    lastOtpSentAt: { type: Date, select: false },

    // --- PASSWORD-RESET flow (Forgot Password) ---
    // Kept SEPARATE from the registration `otp`/`otpExpiry` above on purpose: a
    // user could ask to reset their password while still mid-registration, and the
    // two codes must never overwrite each other. These are the 6-digit reset code
    // and its expiry, both hidden from responses and CLEARED the instant the code
    // is verified so it can't be reused.
    resetOtp: { type: String, select: false },
    resetOtpExpiry: { type: Date, select: false },

    // Mirror of otpAttempts for the reset flow: counts consecutive WRONG
    // verify-reset-otp attempts and burns the reset code once the max is hit.
    resetOtpAttempts: { type: Number, default: 0, select: false },

    // Powers the reset-OTP resend cooldown (mirror of lastOtpSentAt, but for the
    // reset flow). Hidden from responses.
    lastResetOtpSentAt: { type: Date, select: false },

    // GHOST CLEANUP: set to now+24h for brand-new unverified accounts. A TTL
    // index (below) auto-deletes a document once this date passes. On successful
    // verification we UNSET this field, which makes the account permanent.
    expiresAt: { type: Date },
  },
  {
    // Adds createdAt / updatedAt automatically.
    timestamps: true,
  },
);

// --- Indexes ---
// TTL index: MongoDB deletes a doc ~when `expiresAt` passes (expireAfterSeconds:0
// means "expire exactly at the stored time"). Only unverified users carry an
// `expiresAt`, so verified users are never touched. This is the whole "delete
// abandoned signups" feature — no background worker needed.
userSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// --- Hooks ---
// Hash the password automatically right before saving, but only when it actually
// changed. This guarantees a plain-text password is NEVER stored, no matter which
// code path set it. NOTE: this is an async hook, so Mongoose uses the returned
// promise — we must NOT declare/call `next` here (it isn't passed to async hooks).
userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password') || !this.password) return;
  const salt = await bcrypt.genSalt(config.bcryptSaltRounds);
  this.password = await bcrypt.hash(this.password, salt);
});

// Safety net: whenever a user document is converted to JSON (i.e. sent in a
// response), strip anything sensitive/internal. Even if a query accidentally
// selected the password, it can never leak out of an API response.
userSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.password;
    delete ret.otp;
    delete ret.otpExpiry;
    delete ret.otpAttempts;
    delete ret.lastOtpSentAt;
    delete ret.resetOtp;
    delete ret.resetOtpExpiry;
    delete ret.resetOtpAttempts;
    delete ret.lastResetOtpSentAt;
    return ret;
  },
});

const User = mongoose.model('User', userSchema);

module.exports = User;
module.exports.ROLES = ROLES;
