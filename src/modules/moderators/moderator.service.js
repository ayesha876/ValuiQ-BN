/**
 * moderator.service.js — the BUSINESS LOGIC for moderator invites/memberships
 * (HTTP-agnostic). Decides WHAT should happen (self-invite/duplicate rules, token
 * minting, record-first-then-send) and calls the repository for anything that
 * touches the database. It never uses req/res and never writes Mongoose queries.
 */
const crypto = require('crypto');
const config = require('../../shared/config/env');
const AppError = require('../../shared/utils/errors');
const { sendInviteEmail } = require('../../integrations/mailer/mailer.client');
const authRepo = require('../auth/auth.repository');
const eventRepo = require('../events/event.repository');
const repo = require('./moderator.repository');
const { INVITE_TTL_DAYS } = require('./moderatorInvite.model');

const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

// The public app origin used for links in emails. CLIENT_URL may be a comma-list
// (dev :5173 + :5174, staging, ...) — the FIRST entry is the canonical origin.
const clientOrigin = () => config.clientUrl.split(',')[0].trim();

// SHA-256 hex of a string. We store/look up the HASH of an invite token, never the
// raw token itself, so a DB leak can't be used to accept invites.
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Mint a one-time invite token: a high-entropy raw string (goes ONLY in the email
// link) and its hash (the only thing we store). At 256 bits of entropy, enumerating
// the not-found/expired/used responses isn't a practical risk.
function issueInviteToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, tokenHash: sha256(raw) };
}

/**
 * "Send" the invite. In development we ALSO print the accept link to the console so
 * the flow is testable with no real inbox. A send failure is fatal in production but
 * non-fatal in dev (the console link is enough) — mirrors auth's deliverOtp. Called
 * AFTER the invite row is saved, so a failed send always leaves a recoverable record.
 */
async function deliverInvite({ email, rawToken, eventName }) {
  const inviteUrl = `${clientOrigin()}/accept-invite?token=${rawToken}`;
  if (!config.isProduction) {
    console.log(`\n[DEV INVITE] ${email} -> ${inviteUrl} (valid ${INVITE_TTL_DAYS} days)\n`);
  }
  try {
    await sendInviteEmail({ to: email, inviteUrl, eventName, expiryDays: INVITE_TTL_DAYS });
  } catch (err) {
    if (config.isProduction) throw err;
    console.warn('[mailer] Dev invite send failed — use the console link above:', err.message);
  }
}

/**
 * INVITE — the organizer invites one email to moderate their event.
 * - the email resolves to the event OWNER   -> 400 (can't invite yourself)
 * - the email is already an ACTIVE member    -> 409
 * - a PENDING invite already exists          -> idempotent resend (same row, new
 *                                               token + fresh expiry)
 * - otherwise                                -> create a new pending invite
 * @returns {{ invite, resent: boolean }}
 */
async function inviteModerator({ event, email, inviter }) {
  // One lookup answers both "is this me?" and "are they already in?".
  const invitee = await authRepo.findByEmail(email);
  if (invitee) {
    if (invitee.id === event.owner.toString()) {
      throw new AppError(400, 'You cannot invite yourself to your own event.');
    }
    const alreadyMember = await repo.existsActiveMembership({
      userId: invitee.id,
      eventId: event.id,
    });
    if (alreadyMember) {
      throw new AppError(409, 'This person is already a moderator of this event.');
    }
  }

  const { raw, tokenHash } = issueInviteToken();

  // Resend path: refresh the SAME pending row (new token + fresh window) so the
  // partial-unique {event,email} guard is never violated by a second row.
  const pending = await repo.findPendingInvite({ eventId: event.id, email });
  let invite;
  let resent = false;
  if (pending) {
    pending.tokenHash = tokenHash;
    pending.expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    invite = await repo.save(pending);
    resent = true;
  } else {
    invite = await repo.createInvite({
      event: event.id,
      email,
      tokenHash,
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
  }

  // Record saved -> now send (a failed send leaves the row recoverable).
  await deliverInvite({ email, rawToken: raw, eventName: event.name });
  return { invite, resent };
}

/**
 * LIST — the event's moderators as ONE unified array for the host screen: active
 * members and pending invites, each tagged with its `status`. `status` also tells
 * the FE which revoke endpoint a row uses (active -> member id, pending -> invite id).
 * Active members are listed first, then pending invites (each already newest-first).
 * @returns {{ moderators: Array }}
 */
async function listModerators({ event }) {
  const [members, invites] = await Promise.all([
    repo.findActiveMembers(event.id),
    repo.findPendingInvitesForEvent(event.id),
  ]);

  const activeRows = members.map((m) => ({
    id: m._id,
    status: 'active',
    // user is populated; guard in case the account was later deleted.
    email: m.user ? m.user.email : null,
    role: m.role,
    joinedAt: m.joinedAt,
  }));

  const pendingRows = invites.map((i) => ({
    id: i._id,
    status: 'pending',
    email: i.email,
    invitedAt: i.createdAt,
    expiresAt: i.expiresAt,
  }));

  return { moderators: [...activeRows, ...pendingRows] };
}

/**
 * ACCEPT — the invited (and now authenticated) user redeems their token.
 * Precedence, checked in this order:
 *   - token matches no invite            -> 404
 *   - invite is pending but past expiry   -> 410  (lazy: nothing flips it, so we check
 *                                            the TIMESTAMP, not just the stored status)
 *   - invite already accepted/revoked     -> 409  (a used / cancelled token)
 *   - caller's email != invite.email      -> 403  (strict match)
 *   - the event was removed               -> 410
 * Otherwise: upsert an ACTIVE membership (idempotent via the unique {user,event}
 * index — safe on double-click, cleanly reactivates a revoked member) and mark the
 * invite accepted. Being already a member simply returns success (no error).
 * @returns {{ eventId, role, eventName }}
 */
async function acceptInvite({ userId, token }) {
  const invite = await repo.findInviteByTokenHash(sha256(token));
  if (!invite) throw new AppError(404, 'This invitation is invalid.');

  if (invite.status === 'pending' && invite.expiresAt.getTime() < Date.now()) {
    throw new AppError(410, 'This invitation has expired.');
  }
  if (invite.status !== 'pending') {
    throw new AppError(409, 'This invitation is no longer valid.');
  }

  // Strict email match: only the invited email's account may accept.
  const user = await authRepo.findById(userId);
  if (!user) throw new AppError(401, 'Please log in again.');
  if (user.email !== invite.email) {
    throw new AppError(403, 'This invitation was sent to a different email address.');
  }

  // The event must still exist (not soft-deleted) to join.
  const event = await eventRepo.findActiveById(invite.event);
  if (!event) throw new AppError(410, 'This event is no longer available.');

  // Idempotent create-or-reactivate, then mark the invite consumed.
  const membership = await repo.upsertActiveMembership({
    userId: user.id,
    eventId: event.id,
    invitedBy: invite.invitedBy,
  });
  await repo.markInviteAccepted({ inviteId: invite.id, userId: user.id });

  return { eventId: event.id, role: membership.role, eventName: event.name };
}

/**
 * REVOKE INVITE — cancel a PENDING invite. Only pending invites can be cancelled;
 * an accepted/already-revoked/expired invite is a state conflict (409). Scoped to the
 * event, so an invite id from another event reads as not-found (404).
 * @returns {{ id }}
 */
async function revokeInvite({ event, inviteId }) {
  const invite = await repo.findInviteByIdForEvent({ inviteId, eventId: event.id });
  if (!invite) throw new AppError(404, 'Invitation not found.');
  if (invite.status !== 'pending') {
    throw new AppError(409, 'Only a pending invitation can be cancelled.');
  }
  invite.status = 'revoked';
  await repo.save(invite);
  return { id: invite.id };
}

/**
 * REVOKE MEMBER — remove an ACTIVE member. The row is KEPT (status -> revoked) so the
 * history survives and a later re-invite can cleanly reactivate it. Removing an
 * already-removed member is a state conflict (409). Scoped to the event (404 otherwise).
 * @returns {{ id }}
 */
async function revokeMember({ event, memberId }) {
  const member = await repo.findMemberByIdForEvent({ memberId, eventId: event.id });
  if (!member) throw new AppError(404, 'Moderator not found.');
  if (member.status !== 'active') {
    throw new AppError(409, 'This moderator has already been removed.');
  }
  member.status = 'revoked';
  await repo.save(member);
  return { id: member.id };
}

module.exports = { inviteModerator, listModerators, acceptInvite, revokeInvite, revokeMember };
