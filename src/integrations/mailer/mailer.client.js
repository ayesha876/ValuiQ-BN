/**
 * mailer.client.js — turns an application event into a message.
 *
 * Each function here does one thing: pick the right template, fill it in, and hand the
 * finished subject/text/html to sendEmail(). It no longer knows or cares which provider
 * delivers it — that decision, and the Resend → SMTP → Ethereal fallback chain behind
 * it, lives in sendEmail.js.
 *
 * The contract callers rely on is unchanged: these THROW when a message could not be
 * sent by any transport. Every caller already treats that as non-fatal in development,
 * because the OTP (and the invite link) are also logged to the console there.
 */
const config = require('./../../shared/config/env');
const { sendEmail } = require('./sendEmail');
const verificationEmail = require('./templates/verificationEmail');
const resetPasswordEmail = require('./templates/resetPasswordEmail');
const inviteEmail = require('./templates/inviteEmail');

/**
 * Sends the verification email containing the OTP.
 *
 * @param {{to: string, otp: string}} params Recipient and the one-time code.
 * @returns {Promise<{provider: string, id?: string}>} Which transport delivered it.
 */
async function sendVerificationEmail({ to, otp }) {
  const { subject, text, html } = verificationEmail({
    otp,
    expiryMinutes: config.otpExpiryMinutes,
  });

  return sendEmail({ to, subject, text, html });
}

/**
 * Sends the password-reset email containing the reset OTP. Deliberately separate from
 * the verification mail above: the two flows have different copy and different expiry
 * windows, and merging them would couple a change in one to a regression in the other.
 *
 * @param {{to: string, otp: string}} params Recipient and the one-time code.
 * @returns {Promise<{provider: string, id?: string}>} Which transport delivered it.
 */
async function sendResetPasswordEmail({ to, otp }) {
  const { subject, text, html } = resetPasswordEmail({
    otp,
    expiryMinutes: config.resetOtpExpiryMinutes,
  });

  return sendEmail({ to, subject, text, html });
}

/**
 * Sends the moderator-invite email containing the accept link.
 *
 * The invite record is created BEFORE this is called, so a failed send leaves a
 * recoverable row rather than a moderator who was never invited.
 *
 * @param {object} params
 * @param {string} params.to Recipient address.
 * @param {string} params.inviteUrl Absolute accept link (built from FRONTEND_URL).
 * @param {string} params.eventName Event the invite is for.
 * @param {number} params.expiryDays How long the link stays valid.
 * @param {string} params.inviterName Who sent it.
 * @returns {Promise<{provider: string, id?: string}>} Which transport delivered it.
 */
async function sendInviteEmail({ to, inviteUrl, eventName, expiryDays, inviterName }) {
  const { subject, text, html } = inviteEmail({ eventName, inviteUrl, expiryDays, inviterName });

  return sendEmail({ to, subject, text, html });
}

module.exports = { sendVerificationEmail, sendResetPasswordEmail, sendInviteEmail };
