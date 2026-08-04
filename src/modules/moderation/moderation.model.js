/**
 * moderation.model.js — the record of WHO decided WHAT about a post, and what it cost.
 *
 * ── THIS COLLECTION IS THE LOCK ───────────────────────────────────────────────────────────
 * The brief asked for the decision to be applied "atomically in a transaction". There are no
 * transactions in this codebase, and that is a deliberate standing decision, not an oversight:
 * `wallet.service.js` explains that Mongo sessions require a replica set the test runner does
 * not provide. So atomicity is bought the way the wallet buys it — with a unique index and a
 * conditional update.
 *
 * The unique index on `post` below is the whole mechanism. To decide a post you must first
 * INSERT a decision row for it. Exactly one insert can win:
 *
 *   - two moderators clicking at the same instant  -> one inserts, one gets E11000
 *   - the fairness worker racing a moderator       -> same, whichever arrives first
 *   - the same request retried after a timeout     -> E11000, and the original is replayed
 *   - two worker instances sweeping the same post  -> same
 *
 * Every one of those collapses to "someone already owns this decision", which is answered by
 * reading the winning row rather than by doing the work twice. A transaction would give
 * all-or-nothing across the writes; this gives EXACTLY-ONCE across retries, which is the
 * property that actually protects the money. A double-refund is unrecoverable — you cannot
 * un-send tokens someone has already spent — so exactly-once is worth more here.
 *
 * ── WHY THE ROW OUTLIVES THE WORK ─────────────────────────────────────────────────────────
 * `status` mirrors the ledger's pending -> applied lifecycle for the same reason: a decision
 * involves several writes (settle the post, book or reverse revenue, refund N attendees), and
 * if the process dies midway the row is the evidence of what was in flight. A `pending`
 * decision older than a few seconds is repairable precisely because it names the post, the
 * outcome, and the moment. The alternative — no row until everything succeeded — makes a
 * half-applied decision invisible, which is the failure this file exists to prevent.
 */
const mongoose = require('mongoose');

/** What a moderator (or the system) can decide. The values the API accepts, verbatim. */
const DECISIONS = ['address', 'dismiss', 'neglect'];

/**
 * Who decided.
 *
 * Required by the brief ("mark the decision source as system not moderator") and independently
 * worth having: auto-neglect is a HOST SLA FAILURE, and an event where most posts were settled
 * by the timer is a materially different event from one a moderator worked through. Without
 * this field those two are indistinguishable after the fact.
 */
const DECISION_SOURCES = ['moderator', 'system'];

// Same three-state lifecycle as the ledger. `failed` means the claim was made but the money
// work could not be completed — the post is left decidable again by the repair path.
const DECISION_STATUSES = ['pending', 'applied', 'failed'];

/**
 * The host's cut per outcome, as a percentage of the post's realised value.
 *
 * ValuiQ_Client_Overview §9 and QinMvpDocs §6:
 *   Addressed -> "Full value of tokens spent"
 *   Dismissed -> "Half the value of tokens spent"
 *   Neglected -> "Nothing" + "Full automatic refund"
 *
 * ⚠️ OPEN QUESTION, FLAGGED NOT GUESSED. On Dismiss the host banks 50%. The documentation does
 * not say what happens to the other 50%: it is not refunded (the docs say "tokens remain
 * spent"), and it is not booked to the host. It is therefore left UNBOOKED — implicitly
 * platform margin. That is the literal reading, but it is a commercial decision rather than a
 * technical one and should be confirmed before real money flows. See the module README.
 */
const HOST_SHARE_PCT = Object.freeze({ address: 100, dismiss: 50, neglect: 0 });

/** Whether an outcome returns every staker's tokens. Only neglect does. */
const REFUNDS_STAKERS = Object.freeze({ address: false, dismiss: false, neglect: true });

const moderationDecisionSchema = new mongoose.Schema(
  {
    // THE IDEMPOTENCY ANCHOR — see the unique index below.
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },

    // Denormalised from the post so the per-event decision history does not have to join Post
    // on every row, and so an event's audit trail survives independently of it.
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },

    decision: { type: String, enum: DECISIONS, required: true },
    source: { type: String, enum: DECISION_SOURCES, required: true, default: 'moderator' },

    // Null for `source: 'system'` — nobody decided, the clock did. Not `required` for exactly
    // that reason, and the service enforces the pairing rather than the schema, because the
    // rule is "moderator iff source is moderator", which a per-field flag cannot express.
    moderator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Free text the moderator may supply. Capped: it is shown in an audit list, not an essay.
    reason: { type: String, trim: true, maxlength: 500, default: '' },

    status: { type: String, enum: DECISION_STATUSES, default: 'pending', index: true },

    // ── The financial outcome, snapshotted ────────────────────────────────────────────────
    // Recomputing these later would give a DIFFERENT answer: an attendee's cents-per-token
    // rate is an average over their purchases, so it moves every time they buy more tokens.
    // A host's earnings for a post decided in July must not drift because an attendee bought
    // a bigger package in August. What was booked is booked, and it is recorded here.
    hostEarnedCents: { type: Number, default: 0, min: 0 },
    refundedTokens: { type: Number, default: 0, min: 0 },
    stakerCount: { type: Number, default: 0, min: 0 },

    // The value the whole post realised, before the host's share was taken. Kept so a host
    // can be shown "you earned 1500 of a possible 3000" without re-deriving anything.
    grossValueCents: { type: Number, default: 0, min: 0 },

    appliedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * ONE DECISION PER POST, FOREVER. This is the guarantee the whole module rests on.
 *
 * Not partial and not conditional on status: even a `failed` decision holds the slot, so a
 * post whose settlement went wrong cannot be quietly re-decided into a second set of refunds.
 * Clearing it is an explicit repair action, which is the correct amount of friction for
 * something that moves money.
 */
moderationDecisionSchema.index({ post: 1 }, { unique: true });

// Serves the per-event audit trail and the "what did the timer settle for me?" host view.
moderationDecisionSchema.index({ event: 1, createdAt: -1 });

// Serves the repair sweep: decisions that claimed a post but never finished settling it.
moderationDecisionSchema.index({ status: 1, createdAt: 1 });

moderationDecisionSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const ModerationDecision = mongoose.model('ModerationDecision', moderationDecisionSchema);

module.exports = ModerationDecision;
module.exports.DECISIONS = DECISIONS;
module.exports.DECISION_SOURCES = DECISION_SOURCES;
module.exports.DECISION_STATUSES = DECISION_STATUSES;
module.exports.HOST_SHARE_PCT = HOST_SHARE_PCT;
module.exports.REFUNDS_STAKERS = REFUNDS_STAKERS;
