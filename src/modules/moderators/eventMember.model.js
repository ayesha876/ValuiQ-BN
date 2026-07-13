/**
 * eventMember.model.js — a DURABLE "user X is a moderator on event Y" fact.
 *
 * Model layer only: shape + data-level rules. No business logic. Unlike
 * ModeratorInvite (an ephemeral, consumable token), a membership is PERMANENT:
 * created when an invite is accepted, flipped to `revoked` when the organizer
 * removes the moderator (never hard-deleted, so the history survives).
 * `role`/`permissions` are forward-looking hooks for the future Posts/Moderation
 * modules — TODAY authorization is driven simply by an ACTIVE membership existing.
 */
const mongoose = require('mongoose');

// Extensible now, single value today. A membership is a PER-EVENT role, distinct
// from the global User.role: a global 'Event Organizer' can also be a moderator
// here on someone else's event (two hats).
const MEMBER_ROLES = ['moderator'];

// active = counts for authorization. revoked = kept for history, ignored by guards.
const MEMBER_STATUSES = ['active', 'revoked'];

const eventMemberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },

    role: { type: String, enum: MEMBER_ROLES, default: 'moderator' },

    // Forward-looking ONLY: nothing reads this yet (auth is role/membership-driven).
    // No seed value on purpose — an array of String auto-defaults to [], so early
    // docs carry no placeholder strings that might not match the future moderation
    // vocabulary. Populated when Posts/Moderation lands.
    permissions: { type: [String] },

    status: { type: String, enum: MEMBER_STATUSES, default: 'active' },

    // Who invited them (the organizer). Audit trail.
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // When the membership first became active.
    joinedAt: { type: Date, default: Date.now },
  },
  {
    // Adds createdAt / updatedAt automatically.
    timestamps: true,
  },
);

// --- Indexes ---
// One membership per (user, event). UNIQUE is what makes accept an idempotent,
// race-safe upsert (a double-click / retry can't create a second row) and lets a
// previously-revoked member be cleanly reactivated on re-accept.
eventMemberSchema.index({ user: 1, event: 1 }, { unique: true });
// Serves "list this event's active members".
eventMemberSchema.index({ event: 1, status: 1 });

// Mirror the other models: expose `id`, hide `_id`/`__v`.
eventMemberSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const EventMember = mongoose.model('EventMember', eventMemberSchema);

module.exports = EventMember;
module.exports.MEMBER_ROLES = MEMBER_ROLES;
module.exports.MEMBER_STATUSES = MEMBER_STATUSES;
