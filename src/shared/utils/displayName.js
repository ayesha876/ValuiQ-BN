/**
 * displayName.js — a name to show beside a person.
 *
 * The User model has no name field: accounts are created with an email and a role, nothing
 * else. So the local part of the email is the only thing available. "sarah.chen@…" becomes
 * "Sarah Chen", which reads like a person rather than a login.
 *
 * Extracted from `post.service.js`, which has always done this, because the attendee and
 * moderator dashboards now need the same answer for hosts and moderators. Two copies of this
 * would drift, and the drift would be visible: the same person named one way in the feed and
 * another in the moderator list.
 *
 * @param {{email?: string}} userDoc - Any user-shaped record.
 * @param {string} [fallback] - What to return when there is nothing to derive from.
 * @returns {string} A display name.
 *
 * @example
 * displayNameFor({ email: 'sarah.chen@example.com' }); // => 'Sarah Chen'
 * displayNameFor({});                                  // => 'Attendee'
 */
function displayNameFor(userDoc, fallback = 'Attendee') {
  const local = userDoc?.email?.split('@')[0] ?? '';
  const pretty = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return pretty || fallback;
}

module.exports = { displayNameFor };
