/**
 * sendEmail.js — the ONE function that puts a message on the wire.
 *
 * Everything above this file (verification OTPs, password resets, moderator invites)
 * builds a subject and a body and then stops caring how it is delivered. This file is
 * the only place that knows there is more than one way to deliver it.
 *
 * ── THREE TRANSPORTS, TRIED IN ORDER ─────────────────────────────────────────────────
 *   1. RESEND   — primary, when RESEND_API_KEY is set. An HTTPS API call, which matters
 *                 on hosts that throttle or block outbound SMTP ports.
 *   2. SMTP     — fallback, when SMTP_HOST/USER/PASS are set (Gmail app password, etc).
 *   3. ETHEREAL — dev only. A fake inbox created on the fly; nothing is delivered, and
 *                 a preview URL is logged instead.
 *
 * ── WHY FALL THROUGH RATHER THAN PICK ONE ────────────────────────────────────────────
 * The messages that go through here are not marketing — they are the OTP standing
 * between a user and their account, and the invite link standing between a moderator
 * and an event. A provider outage on that path locks people out of the product. Resend
 * failing (rate limit, unverified sender, incident) therefore logs and CONTINUES to
 * SMTP rather than throwing, so one dead provider degrades to the slower path instead
 * of dropping the mail.
 *
 * The throw-on-failure contract only applies once EVERY configured transport has
 * failed. Callers already treat a throw as non-fatal in development, because the OTP is
 * logged to the console there as well.
 */
const nodemailer = require('nodemailer');
const config = require('./../../shared/config/env');
const { createLogger } = require('../../shared/utils/logger');

const log = createLogger('mailer');

// Built once and reused. Creating a transport per message is wasteful for SMTP and, for
// Ethereal, would hit the network on every send. Cached as a PROMISE because Ethereal
// account creation is async.
let transporterPromise = null;
let resendClient = null;

/** True when Resend is configured. Callers branch on this rather than catching. */
function isResendEnabled() {
  return Boolean(config.resend.apiKey);
}

/** True when real SMTP credentials are present. */
function isSmtpEnabled() {
  return Boolean(config.email.host && config.email.user && config.email.pass);
}

/**
 * Lazily constructs the Resend client.
 *
 * `require` is deferred rather than done at module load so that a checkout without the
 * optional dependency installed still boots and still sends over SMTP. A missing package
 * should cost you the primary transport, not the process.
 *
 * @returns {object|null} The client, or null when Resend is unconfigured/unavailable.
 */
function getResend() {
  if (!isResendEnabled()) return null;
  if (resendClient) return resendClient;

  try {
    // eslint-disable-next-line global-require
    const { Resend } = require('resend');
    resendClient = new Resend(config.resend.apiKey);
  } catch (err) {
    log.warn('RESEND_API_KEY is set but the `resend` package is not installed', {
      err: err.message,
    });
    return null;
  }

  return resendClient;
}

/**
 * Builds the Nodemailer transport: real SMTP when configured, Ethereal otherwise.
 *
 * @returns {Promise<import('nodemailer').Transporter>} The cached transport.
 */
async function getTransporter() {
  if (transporterPromise) return transporterPromise;

  transporterPromise = (async () => {
    if (isSmtpEnabled()) {
      return nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.port === 465, // 465 = implicit TLS
        auth: { user: config.email.user, pass: config.email.pass },
      });
    }

    const testAccount = await nodemailer.createTestAccount();
    log.info('No SMTP configured — using Ethereal test inbox.');
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
 * Sends one message through the first transport that works.
 *
 * @param {object} message
 * @param {string} message.to Recipient address.
 * @param {string} message.subject Subject line.
 * @param {string} message.text Plain-text body.
 * @param {string} message.html HTML body.
 * @returns {Promise<{provider: string, id?: string, info?: object}>} Which transport sent it.
 * @throws {Error} When every configured transport failed.
 */
async function sendEmail({ to, subject, text, html }) {
  const from = config.email.from;
  const failures = [];

  // 1. Resend.
  const resend = getResend();
  if (resend) {
    try {
      const { data, error } = await resend.emails.send({ from, to, subject, text, html });

      // The SDK reports delivery problems in the `error` field rather than by throwing,
      // so an unchecked call looks successful while sending nothing at all.
      if (error) throw new Error(error.message || String(error));

      return { provider: 'resend', id: data?.id };
    } catch (err) {
      failures.push(`resend: ${err.message}`);
      log.warn('Resend send failed — falling back to SMTP', { err: err.message });
    }
  }

  // 2. SMTP, or 3. Ethereal in development.
  //
  // Guarded because with no Resend, no SMTP and NODE_ENV=production, the only remaining
  // transport is a fake inbox. Silently "sending" a password reset into Ethereal in
  // production is worse than failing: the user waits for a mail that was never real.
  if (!isSmtpEnabled() && config.isProduction) {
    failures.push('smtp: not configured');
    throw new Error(`No email transport available in production (${failures.join('; ')})`);
  }

  try {
    const transporter = await getTransporter();
    const info = await transporter.sendMail({ from, to, subject, text, html });

    // For the Ethereal fallback this prints a clickable URL to view the message.
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) log.info(`Preview the email here: ${preview}`);

    return { provider: isSmtpEnabled() ? 'smtp' : 'ethereal', id: info.messageId, info };
  } catch (err) {
    failures.push(`smtp: ${err.message}`);
    throw new Error(`Email send failed (${failures.join('; ')})`);
  }
}

/** Reset cached clients. Exported for tests so one suite's config cannot leak into the next. */
function resetTransports() {
  transporterPromise = null;
  resendClient = null;
}

module.exports = { sendEmail, isResendEnabled, isSmtpEnabled, resetTransports };
