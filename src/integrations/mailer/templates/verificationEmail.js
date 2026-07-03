/**
 * verificationEmail.js — builds the content of the "verify your email" message.
 *
 * WHY a separate file: keeping the email's wording/HTML out of the sending code
 * means a designer or PM can tweak the copy here without touching any logic, and
 * we can add more templates (invite, reset, receipt) the same way later.
 *
 * It returns a plain object { subject, text, html } — the mailer client just
 * hands that to Nodemailer.
 */

/**
 * @param {object} params
 * @param {string} params.otp  - the 6-digit code to show the user.
 * @param {number} params.expiryMinutes - how long the code stays valid.
 */
function verificationEmail({ otp, expiryMinutes }) {
  const subject = 'Your ValuiQ verification code';

  // Plain-text version for email clients that don't render HTML.
  const text =
    `Welcome to ValuiQ!\n\n` +
    `Your verification code is: ${otp}\n` +
    `It expires in ${expiryMinutes} minutes.\n\n` +
    `If you didn't request this, you can ignore this email.`;

  // Simple, self-contained HTML (inline styles — email clients strip <style>).
  const html = `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #111318;">
    <h2 style="margin: 0 0 8px;">Verify your email</h2>
    <p style="margin: 0 0 16px; color: #4b5563;">
      Welcome to ValuiQ! Use the code below to verify your account.
    </p>
    <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; text-align: center;
                background: #f3f4f6; border-radius: 10px; padding: 16px 0; margin: 16px 0;">
      ${otp}
    </div>
    <p style="margin: 0; color: #6b7280; font-size: 14px;">
      This code expires in ${expiryMinutes} minutes. If you didn't request it, ignore this email.
    </p>
  </div>`;

  return { subject, text, html };
}

module.exports = verificationEmail;
