/**
 * mailer.client.js — the ONE place that actually sends email (via Nodemailer).
 *
 * Two modes, chosen automatically so you can test WITHOUT real SMTP:
 *   1. REAL SMTP  — used when EMAIL_HOST/USER/PASS are set in .env.
 *   2. ETHEREAL   — a free fake inbox Nodemailer creates on the fly (dev only).
 *                   Nothing is really delivered; instead we log a "preview URL"
 *                   where you can view the email in a browser.
 *
 * Either way, the SERVICE also prints the OTP straight to the server console in
 * development, so you can verify the flow even with no inbox at all.
 */
const nodemailer = require('nodemailer');
const config = require('./../../shared/config/env');
const verificationEmail = require('./templates/verificationEmail');
const resetPasswordEmail = require('./templates/resetPasswordEmail');
const inviteEmail = require('./templates/inviteEmail');

// We build the transporter once and reuse it (creating one per email is wasteful
// and, for Ethereal, would hit the network every time). Cached as a PROMISE
// because Ethereal setup is async.
let transporterPromise = null;

async function getTransporter() {
  if (transporterPromise) return transporterPromise;

  transporterPromise = (async () => {
    // Mode 1: real SMTP from .env.
    if (config.email.host && config.email.user && config.email.pass) {
      return nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.port === 465, // 465 = implicit TLS
        auth: { user: config.email.user, pass: config.email.pass },
      });
    }

    // Mode 2: Ethereal test account (dev fallback, no real delivery).
    const testAccount = await nodemailer.createTestAccount();
    console.log('[mailer] No SMTP configured — using Ethereal test inbox.');
    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
  })();

  return transporterPromise;
}

/**
 * Sends the verification email containing the OTP.
 * Throws if sending fails — the caller decides whether that's fatal (in dev the
 * service treats a send failure as non-fatal because the OTP is also logged).
 */
async function sendVerificationEmail({ to, otp }) {
  const { subject, text, html } = verificationEmail({
    otp,
    expiryMinutes: config.otpExpiryMinutes,
  });

  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: config.email.from,
    to,
    subject,
    text,
    html,
  });

  // For the Ethereal fallback, this prints a clickable URL to view the email.
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log('[mailer] Preview the email here:', preview);

  return info;
}

/**
 * Sends the password-reset email containing the reset OTP. Same behaviour and
 * error contract as sendVerificationEmail — throws if sending fails, and the
 * service decides whether that's fatal (in dev it isn't, because the OTP is also
 * logged to the console).
 */
async function sendResetPasswordEmail({ to, otp }) {
  const { subject, text, html } = resetPasswordEmail({
    otp,
    expiryMinutes: config.resetOtpExpiryMinutes,
  });

  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: config.email.from,
    to,
    subject,
    text,
    html,
  });

  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log('[mailer] Preview the email here:', preview);

  return info;
}

/**
 * Sends the moderator-invite email containing the accept link. Same behaviour and
 * error contract as the others — throws if sending fails, and the SERVICE decides
 * whether that's fatal: the invite record is created FIRST, so a failed send leaves
 * a recoverable row, and in dev the accept link is also logged to the console.
 */
async function sendInviteEmail({ to, inviteUrl, eventName, expiryDays, inviterName }) {
  const { subject, text, html } = inviteEmail({ eventName, inviteUrl, expiryDays, inviterName });

  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: config.email.from,
    to,
    subject,
    text,
    html,
  });

  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log('[mailer] Preview the email here:', preview);

  return info;
}

module.exports = { sendVerificationEmail, sendResetPasswordEmail, sendInviteEmail };
