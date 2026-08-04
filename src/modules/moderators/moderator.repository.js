/**
 * moderator.repository.js — the ONLY file that talks to the moderator collections
 * (ModeratorInvite + EventMember).
 *
 * The service/middleware say WHAT they want ("is this user an active member?"); this
 * file knows HOW (the Mongoose query). If storage ever changes, only this file does.
 * It grows one function per use case as the endpoints are built.
 */
const ModeratorInvite = require('./moderatorInvite.model');
const EventMember = require('./eventMember.model');

// --- Invites ---

// The single PENDING invite for this (event, email), if any. Used to decide between
// creating a new invite and resending the existing one. tokenHash stays hidden
// (select:false) — resend overwrites it, so it's never needed on read.
function findPendingInvite({ eventId, email }) {
  return ModeratorInvite.findOne({ event: eventId, email, status: 'pending' });
}

// Create a brand-new invite from a fully-assembled payload (event/tokenHash/... set
// by the service — never from the client).
function createInvite(data) {
  return ModeratorInvite.create(data);
}

// Persist changes to an invite/member document we already loaded (e.g. a resend
// overwriting tokenHash + expiresAt, or a revoke flipping status).
function save(doc) {
  return doc.save();
}

// All PENDING invites for an event (host list view), newest first. lean() — these
// rows are read-only. tokenHash stays hidden (select:false) and is never needed here.
function findPendingInvitesForEvent(eventId) {
  return ModeratorInvite.find({ event: eventId, status: 'pending' })
    .sort({ createdAt: -1 })
    .lean();
}

// Find an invite by its token hash — the accept lookup. tokenHash is select:false,
// but we query BY it (never return it). Returns the full doc so the service can read
// status/expiresAt/email/event and act on it.
function findInviteByTokenHash(tokenHash) {
  return ModeratorInvite.findOne({ tokenHash });
}

// Mark a still-PENDING invite accepted. Conditional on status:'pending' so a
// concurrent double-accept marks it exactly once (a no-op if already accepted).
function markInviteAccepted({ inviteId, userId }) {
  return ModeratorInvite.updateOne(
    { _id: inviteId, status: 'pending' },
    { $set: { status: 'accepted', acceptedBy: userId, acceptedAt: new Date() } },
  );
}

// A single invite by id, SCOPED to its event (so an invite id from another event
// reads as not-found -> 404). Full doc so the service can flip status on revoke.
function findInviteByIdForEvent({ inviteId, eventId }) {
  return ModeratorInvite.findOne({ _id: inviteId, event: eventId });
}

// --- Memberships ---

// Is this user an ACTIVE moderator member of this event? Revoked memberships don't
// count. Used by requireEventModerator (and, later, the Posts/Moderation guards).
// Returns a truthy lean doc ({ _id }) or null — callers treat it as a boolean.
function existsActiveMembership({ userId, eventId }) {
  return EventMember.exists({ user: userId, event: eventId, status: 'active' });
}

// All ACTIVE members of an event (host list view), newest first, with each member's
// user email/role populated so the list can show who they are. lean() — read-only.
function findActiveMembers(eventId) {
  return EventMember.find({ event: eventId, status: 'active' })
    .populate('user', 'email role')
    .sort({ createdAt: -1 })
    .lean();
}

// Create-or-reactivate the (user, event) membership as ACTIVE in ONE atomic upsert
// against the unique {user,event} index. Idempotent: a double-accept can't make two
// rows, and a previously-revoked member is cleanly reactivated. role/invitedBy/joinedAt
// are set only on first insert. A rare concurrent-insert race surfaces as E11000 —
// we retry once, which then finds the now-existing row and updates it.
async function upsertActiveMembership({ userId, eventId, invitedBy }) {
  const run = () =>
    EventMember.findOneAndUpdate(
      { user: userId, event: eventId },
      {
        $set: { status: 'active' },
        $setOnInsert: { role: 'moderator', invitedBy, joinedAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  try {
    return await run();
  } catch (err) {
    if (err.code === 11000) return run(); // lost the insert race -> now it exists, update it
    throw err;
  }
}

// A single member by id, SCOPED to its event (a member id from another event reads
// as not-found -> 404). Full doc so the service can flip status on removal.
function findMemberByIdForEvent({ memberId, eventId }) {
  return EventMember.findOne({ _id: memberId, event: eventId });
}

module.exports = {
  findPendingInvite,
  createInvite,
  save,
  findPendingInvitesForEvent,
  findInviteByTokenHash,
  markInviteAccepted,
  findInviteByIdForEvent,
  existsActiveMembership,
  findActiveMembers,
  upsertActiveMembership,
  findMemberByIdForEvent,
};
