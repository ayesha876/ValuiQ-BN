/**
 * resetPasswordEmail.js — builds the content of the "reset your password" email.
 *
 * Mirrors verificationEmail.js: it only produces copy/markup and returns a plain
 * { subject, text, html } object. The mailer client hands that to Nodemailer.
 * Keeping the wording here (separate from the sending logic) means copy can be
 * tweaked without touching any code that talks to the mail server.
 */

/**
 * @param {object} params
 * @param {string} params.otp            - the 6-digit reset code to show the user.
 * @param {number} params.expiryMinutes  - how long the code stays valid.
 */
function resetPasswordEmail({ otp, expiryMinutes }) {
  const subject = 'Your ValuiQ password reset code';

  // Plain-text version for clients that don't render HTML.
  const text =
    `We received a request to reset your ValuiQ password.\n\n` +
    `Your password reset code is: ${otp}\n` +
    `It expires in ${expiryMinutes} minutes.\n\n` +
    `If you didn't request this, you can safely ignore this email — ` +
    `your password will stay the same.`;

  // Simple, self-contained HTML (inline styles — email clients strip <style>).
  const html = `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #111318;">
    <h2 style="margin: 0 0 8px;">Reset your password</h2>
    <p style="margin: 0 0 16px; color: #4b5563;">
      We received a request to reset your ValuiQ password. Use the code below to continue.
    </p>
    <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; text-align: center;
                background: #f3f4f6; border-radius: 10px; padding: 16px 0; margin: 16px 0;">
      ${otp}
    </div>
    <p style="margin: 0; color: #6b7280; font-size: 14px;">
      This code expires in ${expiryMinutes} minutes. If you didn't request a reset,
      ignore this email and your password will remain unchanged.
    </p>
  </div>`;

  return { subject, text, html };
}

module.exports = resetPasswordEmail;
