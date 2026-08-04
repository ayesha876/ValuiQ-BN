/**
 * wallet.model.js — the token balance and the record of every movement.
 *
 * Two schemas in one file because they are one concept: a balance is only trustworthy if
 * every change to it is written down, and they always change together.
 *
 * The balance lives here rather than on the User document so that money stays out of the auth
 * model — a wallet change can never affect a login, and wallet-specific fields have somewhere
 * to live without growing the user schema.
 *
 * WHY A LEDGER AND NOT JUST A NUMBER: when a balance is wrong, a number tells you nothing. The
 * ledger is append-only and signed (negative = spent), so it can be summed and compared against
 * the balance to prove they agree — and to find out where they stopped agreeing.
 */
const mongoose = require('mongoose');

// What moved the tokens. `refund` exists so the mechanism is ready for Week 4 moderation —
// no refund POLICY is implemented here (and the product docs currently disagree about it).
const LEDGER_TYPES = ['grant', 'purchase', 'post', 'vote', 'refund'];

// pending -> applied on success, pending -> failed when the balance could not cover it.
// A row stuck at `pending` means the process died mid-write: the money may or may not have
// moved, and it is visible rather than lost. See the write order in wallet.service.js.
const LEDGER_STATUSES = ['pending', 'applied', 'failed'];

const walletSchema = new mongoose.Schema(
  {
    // One wallet per user — the unique index is what makes "get or create" idempotent under
    // concurrency, the same way the moderator membership upsert works.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    // Spendable tokens. Whole numbers only: tokens are not divisible, and floats would make
    // sums drift. `min: 0` is a backstop — the real guarantee is the conditional update in
    // the repository, which can never take a balance below zero in the first place.
    balance: { type: Number, default: 0, min: 0 },

    // Running totals, kept for display and reconciliation. Derived from the ledger, so if
    // these ever disagree with it the ledger is right and these are the bug.
    lifetimeGranted: { type: Number, default: 0, min: 0 },
    lifetimePurchased: { type: Number, default: 0, min: 0 },
    lifetimeSpent: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

walletSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const ledgerEntrySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },

    // SIGNED: negative is a debit, positive a credit. Storing the sign rather than a separate
    // direction field means the ledger simply sums to the balance — one number to compare,
    // no branching, and no chance of a direction flag disagreeing with the amount.
    amount: { type: Number, required: true },

    status: { type: String, enum: LEDGER_STATUSES, default: 'pending', index: true },

    // The balance after this entry was applied. Null until then. Makes a discrepancy locatable
    // to a single row instead of a date range.
    balanceAfter: { type: Number, default: null },

    // Unique per intended movement, so a retried request cannot spend twice. Uniqueness is
    // declared as a PARTIAL index below rather than here — see the comment on it.
    idempotencyKey: { type: String, default: null },

    // What this movement was about. Both optional — a grant refers to nothing.
    ref: {
      eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', default: null },
      postId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },

    // What was actually PAID, in cents, when tokens were bought. Null for everything else.
    //
    // Recorded from day one even though purchases are Week 5, because a host's earnings are
    // based on what that attendee actually paid per token on average (QinMvpDocs §6). If this
    // is not captured at purchase time it cannot be reconstructed later — the money is gone
    // into Stripe and the rate is unknowable. No averaging maths lives here.
    fiatCents: { type: Number, default: null },
  },
  { timestamps: true },
);

/**
 * One movement per idempotency key — this index is what makes a retried request safe.
 *
 * PARTIAL, not sparse. A sparse index still indexes an explicit `null`, so every internal
 * movement without a client request behind it (a system refund, a grant) would collide with
 * the previous one on `null`. Restricting the index to actual strings means unkeyed entries
 * are simply not indexed. Same idiom as the partial unique index on moderatorInvite.
 */
ledgerEntrySchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

// Serves "this user's history, newest first" — the wallet screen's query (Week 5).
ledgerEntrySchema.index({ user: 1, createdAt: -1 });

ledgerEntrySchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const Wallet = mongoose.model('Wallet', walletSchema);
const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);

module.exports = { Wallet, LedgerEntry, LEDGER_TYPES, LEDGER_STATUSES };
