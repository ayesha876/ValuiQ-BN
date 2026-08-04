/**
 * inviteEmail.js — builds the content of the "you've been invited to moderate"
 * message. Mirrors verificationEmail/resetPasswordEmail: it returns a plain
 * { subject, text, html } object that the mailer client hands to Nodemailer. Copy
 * and markup live here so they can be tweaked without touching any sending logic.
 */

// Escape values that will be interpolated into HTML. `eventName` (and, if used,
// `inviterName`) are organizer-controlled free text rendered in the INVITEE's inbox,
// so they must never be trusted as markup. The plain-text version needs no escaping.
const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * @param {object} params
 * @param {string} params.eventName    - the event the person is invited to moderate.
 * @param {string} params.inviteUrl    - the accept link (carries the raw one-time token).
 * @param {number} params.expiryDays   - how many days the invite stays valid.
 * @param {string} [params.inviterName]- optional "invited by" label (line omitted if absent).
 */
function inviteEmail({ eventName, inviteUrl, expiryDays, inviterName }) {
  const subject = `You're invited to moderate ${eventName} on ValuiQ`;

  // Plain-text version for email clients that don't render HTML.
  const invitedByText = inviterName ? `Invited by: ${inviterName}\n` : '';
  const text =
    `You've been invited to moderate "${eventName}" on ValuiQ.\n` +
    invitedByText +
    `\nAccept your invitation:\n${inviteUrl}\n\n` +
    `This invite expires in ${expiryDays} days. ` +
    `If you weren't expecting this, you can ignore this email.`;

  // Simple, self-contained HTML (inline styles — email clients strip <style>).
  const safeEventName = escapeHtml(eventName);
  const invitedByHtml = inviterName
    ? `<p style="margin: 0 0 16px; color: #4b5563;">Invited by <strong>${escapeHtml(inviterName)}</strong></p>`
    : '';
  const html = `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #111318;">
    <h2 style="margin: 0 0 8px;">You've been invited to moderate</h2>
    <p style="margin: 0 0 4px; color: #4b5563;">
      You've been invited to help moderate <strong>${safeEventName}</strong> on ValuiQ.
    </p>
    ${invitedByHtml}
    <div style="text-align: center; margin: 24px 0;">
      <a href="${inviteUrl}"
         style="display: inline-block; background: #00F0FF; color: #06181b; text-decoration: none;
                font-weight: 700; padding: 12px 28px; border-radius: 10px;">
        Accept invitation
      </a>
    </div>
    <p style="margin: 0 0 8px; color: #6b7280; font-size: 14px;">
      Or paste this link into your browser:
    </p>
    <p style="margin: 0 0 16px; word-break: break-all; font-size: 13px;">
      <a href="${inviteUrl}" style="color: #0891b2;">${inviteUrl}</a>
    </p>
    <p style="margin: 0; color: #6b7280; font-size: 14px;">
      This invite expires in ${expiryDays} days. If you weren't expecting this, ignore this email.
    </p>
  </div>`;

  return { subject, text, html };
}

module.exports = inviteEmail;
