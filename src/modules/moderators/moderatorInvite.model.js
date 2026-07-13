/**
 * moderatorInvite.model.js — an EPHEMERAL invitation to moderate an event.
 *
 * Model layer only: shape + data-level rules (types, enums, indexes). No business
 * logic and no request handling. An invite is a CONSUMABLE token: it starts
 * `pending`, carries only the SHA-256 HASH of the raw token (the raw token lives
 * solely in the email link), and is later accepted / revoked / expired. It is kept
 * SEPARATE from EventMember (the durable "user X moderates event Y" fact) because
 * the two have different lifecycles — this row is short-lived, that one is permanent.
 */
const mongoose = require('mongoose');

// How long a fresh invite stays valid. One constant, reused on resend so a re-sent
// invite gets the same 7-day window.
const INVITE_TTL_DAYS = 7;

// The states an invite moves through. `pending` is the only actionable one.
const INVITE_STATUSES = ['pending', 'accepted', 'revoked', 'expired'];

const moderatorInviteSchema = new mongoose.Schema(
  {
    // Which event this invite is for. Set server-side from the route, never the body.
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },

    // The invited address. Lowercased/trimmed so the accept-time email match is
    // case-insensitive and the partial-unique {event,email} guard is reliable.
    email: { type: String, required: true, lowercase: true, trim: true },

    // SHA-256 of the raw token. The raw token is NEVER stored — only this hash — so
    // a DB leak can't be used to accept invites. `select:false` keeps it out of
    // normal queries/responses; `required` so the unique index can't trip on null.
    tokenHash: { type: String, required: true, select: false },

    status: { type: String, enum: INVITE_STATUSES, default: 'pending' },

    // When the invite stops being acceptable. NOT a TTL index — an expired row must
    // SURVIVE so the Accept screen can show a distinct "expired" state. Expiry is
    // evaluated lazily on read (see the isExpired virtual + the service).
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    },

    // Who sent it (the organizer). Audit + "invited by" display.
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Filled in when the invite is accepted; null until then.
    acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    acceptedAt: { type: Date, default: null },
  },
  {
    // Adds createdAt / updatedAt automatically.
    timestamps: true,
  },
);

// --- Indexes ---
// DB-level guard against duplicate PENDING invites for the same person on the same
// event. Partial (status:'pending' only) so a fresh invite is still allowed after a
// previous one was revoked/expired — those don't occupy the unique slot.
moderatorInviteSchema.index(
  { event: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
// Serves "list this event's invites (optionally filtered by status)".
moderatorInviteSchema.index({ event: 1, status: 1 });
// The accept lookup key. UNIQUE enforces the real invariant — one token = one
// invite — and fails loudly if a bug ever duplicated a hash (a random 256-bit
// collision is ~0). `required:true` above keeps null out of the unique index.
moderatorInviteSchema.index({ tokenHash: 1 }, { unique: true });

// --- Virtuals ---
// Lazy expiry: an invite is expired if it was explicitly marked so, OR it is still
// PENDING past its window. Accepted/revoked invites are terminal and are never
// counted as expired, even once their timestamp passes.
moderatorInviteSchema.virtual('isExpired').get(function isExpired() {
  return (
    this.status === 'expired' ||
    (this.status === 'pending' && this.expiresAt && this.expiresAt.getTime() < Date.now())
  );
});

// Mirror the other models: expose `id`, hide `_id`/`__v`, and NEVER serialize the
// token hash even if a query happened to select it.
moderatorInviteSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tokenHash;
    return ret;
  },
});

const ModeratorInvite = mongoose.model('ModeratorInvite', moderatorInviteSchema);

module.exports = ModeratorInvite;
module.exports.INVITE_STATUSES = INVITE_STATUSES;
module.exports.INVITE_TTL_DAYS = INVITE_TTL_DAYS;
