/**
 * revenue.model.js — the host's REAL MONEY: what they have earned, and what is owed to them.
 *
 * Two schemas in one file for the same reason wallet.model.js pairs its two: a balance is only
 * trustworthy if every change to it is written down, and they always change together. The
 * wallet holds the number; the entries prove it.
 *
 * ── CENTS, NEVER TOKENS. THE TWO ARE DIFFERENT KINDS OF MONEY ─────────────────────────────
 * An attendee's wallet holds TOKENS — an in-app currency, whole numbers, spendable only here.
 * A host's wallet holds CENTS — real money, destined for a real bank account via Stripe. A
 * moderation decision is the moment one becomes the other, at a rate that differs per attendee
 * (see tokenValueCalculator.js). Keeping them in separate collections with separate units is
 * what stops someone one day adding a token count to a cent count and shipping it.
 *
 * ── WHY THERE IS NO `AttendeeRefund` COLLECTION HERE ──────────────────────────────────────
 * The Week 4 brief asked for one. It is deliberately not built, because this codebase already
 * has a single source of truth for token movement: the `LedgerEntry` collection, which is
 * append-only, signed, and carries `type: 'refund'` and `ref.postId` — both added in Week 3
 * specifically so Week 4 could use them ("`refund` exists so the mechanism is ready for Week 4
 * moderation", wallet.model.js:17).
 *
 * A second table recording the same refunds would be a copy that can disagree with the ledger,
 * and when they disagree there is no way to tell which is right — precisely the failure the
 * ledger was introduced to prevent. So "the refund records for a post" is a QUERY over the
 * ledger (`revenue.repository.findRefundsForPost`) rather than a duplicate write. Same data,
 * one writer, no reconciliation problem. The brief's `PENDING` status also does not apply: a
 * token refund is an immediate wallet credit, with no payment processor in the path.
 */
const mongoose = require('mongoose');

// booked -> the host has earned it and it is owed to them.
// voided  -> a later decision reversed it (today: only Neglect after an Address).
// paid    -> it has left in a payout. Week 6 sets this; nothing does yet.
const REVENUE_STATUSES = ['booked', 'voided', 'paid'];

const hostWalletSchema = new mongoose.Schema(
  {
    // One wallet per host. The unique index is what makes "get or create" idempotent under
    // concurrency — the same idiom as Wallet and the moderator membership upsert.
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    // Earned, not yet paid out. This is the number the host sees as "available to withdraw".
    // `min: 0` is a backstop only; the real guarantee is the conditional update in the
    // repository, which cannot take it negative.
    pendingCents: { type: Number, default: 0, min: 0 },

    // Cumulative, for display and reconciliation. Derived from the entries, so if these ever
    // disagree with a sum over HostRevenueEntry, the entries are right and these are the bug.
    lifetimeBookedCents: { type: Number, default: 0, min: 0 },
    paidCents: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

hostWalletSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const hostRevenueEntrySchema = new mongoose.Schema(
  {
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },

    // ONE ENTRY PER POST — see the unique index below.
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },

    // Which outcome produced this. Only `address` and `dismiss` ever book; `neglect` books
    // nothing, so it never appears here.
    decision: { type: String, enum: ['address', 'dismiss'], required: true },

    // ── The calculation, kept in full ────────────────────────────────────────────────────
    // Storing only `amountCents` would make a host's "why is this 1500 and not 3000?" question
    // unanswerable without re-deriving inputs that have since moved (an attendee's rate is an
    // average over their purchases and changes when they buy more). These four fields make
    // every entry self-explaining and independently checkable on paper.
    grossValueCents: { type: Number, required: true, min: 0 },
    sharePct: { type: Number, required: true, min: 0, max: 100 },
    decisionPct: { type: Number, required: true, min: 0, max: 100 },
    amountCents: { type: Number, required: true, min: 0 },

    status: { type: String, enum: REVENUE_STATUSES, default: 'booked', index: true },
    voidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * ONE REVENUE ENTRY PER POST.
 *
 * Mirrors the unique index on ModerationDecision.post, and is the second line of defence for
 * the same problem: if a retry somehow got past the decision claim, this index still refuses
 * to pay a host twice for one post. Two independent guarantees on the same invariant, because
 * over-crediting real money is not something to protect with a single index.
 */
hostRevenueEntrySchema.index({ post: 1 }, { unique: true });

// Serves the earnings summary: this host's entries, newest first, filterable by status.
hostRevenueEntrySchema.index({ host: 1, status: 1, createdAt: -1 });

hostRevenueEntrySchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const HostWallet = mongoose.model('HostWallet', hostWalletSchema);
const HostRevenueEntry = mongoose.model('HostRevenueEntry', hostRevenueEntrySchema);

module.exports = { HostWallet, HostRevenueEntry, REVENUE_STATUSES };
