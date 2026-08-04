/**
 * post.model.js — an attendee's paid contribution to a live event.
 *
 * A post is not free: `tokens` is what the author staked to submit it, and that stake is also
 * what ranks it (QinMvpDocs: "ranked by token support"). There is no vote COUNT in this
 * product — `tokens` is the running total of the author's opening bid plus every stake others
 * have added since.
 */
const mongoose = require('mongoose');

/**
 * The lifecycle a post can be in.
 *
 * The first three are the PUBLICATION gate (does this post reach the feed). The last three are
 * the Week 4 MODERATION OUTCOME (who gets paid) — reserved by the original author of this file
 * pending a ruling on the revenue rules, which now exists:
 *
 *   addressed  host earns 100% of the post's realised value; nobody is refunded
 *   dismissed  host earns  50%; nobody is refunded
 *   neglected  host earns   0%; every staker is refunded in full
 *
 * Source: ValuiQ_Client_Overview §9 and QinMvpDocs §6, which agree. The earlier "the product
 * docs disagree" note referred to a competing Week 4 brief that made Dismiss financially
 * neutral; that reading was rejected in favour of the client-facing documentation.
 *
 * Two gates, not one: a post is published (`live`) and then settled (`addressed`). They are
 * separate decisions taken at different moments by possibly different people.
 */
const POST_STATUSES = ['in-review', 'live', 'rejected', 'addressed', 'dismissed', 'neglected'];

/**
 * The states from which a moderation decision may still be taken.
 *
 * `in-review` counts: the neglect clock starts at submission, not at approval, so a post that
 * nobody ever reviewed is exactly the case auto-neglect exists to refund.
 *
 * `rejected` does NOT count, and that is a known gap rather than a decision — a rejected post
 * currently keeps the attendee's tokens with no host revenue and no refund. See the "Known
 * gaps" section of `src/modules/moderation/README.md`; it is a money-policy question, not a
 * code one, and Week 4 deliberately does not invent an answer to it.
 */
const DECIDABLE_STATUSES = ['in-review', 'live'];

/** Where a moderation decision leaves a post, by decision name. */
const OUTCOME_STATUS = Object.freeze({
  address: 'addressed',
  dismiss: 'dismissed',
  neglect: 'neglected',
});

const postSchema = new mongoose.Schema(
  {
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Denormalised so the feed can render a name without joining User on every row. A display
    // name is not sensitive and does not change often; the join would cost more than the copy.
    authorName: { type: String, required: true },

    text: { type: String, required: true, trim: true, maxlength: 500 },

    // Total tokens behind this post: the author's opening stake plus every upvote since.
    // THIS IS THE RANK. Maintained by atomic $inc, never recomputed from a read.
    tokens: { type: Number, required: true, min: 0 },

    // What the AUTHOR themselves staked to submit it. Never changes after creation.
    //
    // Recorded rather than derived as `tokens - sum(votes)`, because that subtraction is not
    // reliable: `vote.service` debits the voter, then calls `postRepo.addTokens`, which
    // filters on `status: 'live'` and returns null if the post was settled in between — yet
    // the Vote row is still written. When that happens the vote rows out-total `tokens`, the
    // subtraction goes negative, and the author (the one person with no Vote row) silently
    // loses their refund. Storing the number removes the whole class of problem.
    //
    // Defaults to null for posts written before this field existed; the refund path falls
    // back to the subtraction for those, clamped at zero.
    openingStake: { type: Number, default: null, min: 0 },

    status: { type: String, enum: POST_STATUSES, default: 'in-review', index: true },

    // Which stage this post belongs to. 0 is the Opening Segment. A segmented event cuts its
    // shortlist per round, so a post has to remember which round it was competing in.
    roundIndex: { type: Number, default: 0 },

    // One post per intended submission — a retried request must not create a second row.
    // Uniqueness is a PARTIAL index below, for the same null-collision reason as the ledger.
    idempotencyKey: { type: String, default: null },

    // Set when a moderator lets it through. Null while in review.
    approvedAt: { type: Date, default: null },

    // WHEN THIS POST TIMES OUT AND EVERYONE GETS THEIR TOKENS BACK.
    //
    // Stored rather than derived. It could be computed as `createdAt + stage.neglectTimer`,
    // but the sweep that finds overdue posts has to run across every live event on an
    // interval, and a derived deadline makes that a collection scan joined to Event per row.
    // A stored, indexed Date makes it one range query.
    //
    // It also FREEZES THE PROMISE. `neglectTimer` is attendee-visible — the host publicly
    // commits to answering within it. If the host edits that number later, posts already
    // submitted keep the deadline they were made under, because the commitment was made at
    // submission time. Deriving it would silently move a deadline attendees were shown.
    //
    // Null when the stage sets no timer: no promise was made, so nothing times out.
    neglectDeadlineAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Serves the ranked feed: this event's live posts, highest stake first. `createdAt` is the
// tiebreak so two posts on equal tokens hold a stable order rather than shuffling between
// requests — a feed that reorders for no reason looks broken.
postSchema.index({ event: 1, status: 1, tokens: -1, createdAt: 1 });

// Serves the moderator review queue: what is waiting, oldest first (fairest to answer).
postSchema.index({ event: 1, status: 1, createdAt: 1 });

// Serves the submission cap: how many has this attendee posted in this round?
postSchema.index({ event: 1, author: 1, roundIndex: 1 });

// PARTIAL, not sparse: a sparse unique index still indexes an explicit null, so every post
// created without a client key would collide with the previous one. Same trap as the ledger.
postSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

// Serves the fairness sweep: posts past their deadline that nobody has settled. The status
// filter comes first because it is the selective half — most posts in a finished event are
// already decided, so the index walks a small set of undecided ones by deadline.
postSchema.index({ status: 1, neglectDeadlineAt: 1 });

postSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const Post = mongoose.model('Post', postSchema);

module.exports = Post;
module.exports.POST_STATUSES = POST_STATUSES;
module.exports.DECIDABLE_STATUSES = DECIDABLE_STATUSES;
module.exports.OUTCOME_STATUS = OUTCOME_STATUS;
