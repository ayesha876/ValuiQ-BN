/**
 * moderation.repository.js — the ONLY file that talks to the ModerationDecision collection.
 *
 * The claim below is the concurrency guarantee for the entire module. Keeping it here, in one
 * function, is what stops it being re-implemented somewhere as a findOne-then-create — which
 * would read as equivalent, pass every single-threaded test, and double-refund under load.
 */
const ModerationDecision = require('./moderation.model');

/**
 * ⚠️ THE CLAIM. Try to become the one and only decision on this post.
 *
 * Insert-first, ask questions later. The unique index on `post` means exactly one caller can
 * succeed, so this doubles as the mutual exclusion between two moderators, between a moderator
 * and the fairness worker, and between two worker instances sweeping the same post.
 *
 * Returns `{ claimed: true, decision }` for the winner, or `{ claimed: false, decision }`
 * carrying the EXISTING row for everyone else. A loser is not an error — it is how a retry
 * gets its original answer back, and how a race gets told who won.
 *
 * @param {object} input - The decision to record.
 * @param {string} input.post - Post being decided.
 * @param {string} input.event - Event the post belongs to.
 * @param {'address'|'dismiss'|'neglect'} input.decision - The outcome.
 * @param {'moderator'|'system'} input.source - Who decided.
 * @param {string|null} [input.moderator] - The moderator, or null for a system decision.
 * @param {string} [input.reason] - Optional free text.
 * @returns {Promise<{claimed: boolean, decision: object}>} Winner flag plus the owning row.
 */
async function claim({ post, event, decision, source, moderator = null, reason = '' }) {
  try {
    const created = await ModerationDecision.create({
      post,
      event,
      decision,
      source,
      moderator,
      reason,
      status: 'pending',
    });
    return { claimed: true, decision: created };
  } catch (err) {
    if (err.code === 11000) {
      // Someone else owns this post's decision. Hand back theirs so the caller can replay it.
      //
      // The read can legitimately come back null in a very narrow window: the winning insert
      // has taken the index slot but its document is not yet visible to this read. Null tells
      // the caller "contended, unknown" rather than "free", which it answers with a 409 —
      // never by retrying the claim, which is how a double-refund would be born.
      const existing = await ModerationDecision.findOne({ post });
      return { claimed: false, decision: existing };
    }
    throw err;
  }
}

/** The decision on a post, if one exists. */
function findByPost(postId) {
  return ModerationDecision.findOne({ post: postId });
}

/**
 * Record that the decision was fully settled, with what it actually cost.
 *
 * Conditional on `status: 'pending'` so a repair pass and the original request cannot both
 * mark the same decision applied with different figures.
 *
 * @param {string} id - Decision id.
 * @param {{hostEarnedCents: number, refundedTokens: number, stakerCount: number, grossValueCents: number}} outcome
 * @returns {Promise<object|null>} The applied decision, or null if it was no longer pending.
 */
function markApplied(id, outcome) {
  return ModerationDecision.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { ...outcome, status: 'applied', appliedAt: new Date() } },
    { new: true },
  );
}

/**
 * Record that settlement failed after the claim was taken.
 *
 * The row stays — it is the evidence of what was attempted. It also keeps the post's decision
 * slot occupied, which is intentional: a post whose settlement half-happened must not be
 * silently re-decidable into a second set of refunds. Releasing it is an explicit repair.
 *
 * @param {string} id - Decision id.
 * @returns {Promise<object|null>} The failed decision.
 */
function markFailed(id) {
  return ModerationDecision.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'failed' } },
    { new: true },
  );
}

/** One event's decision history, newest first — the host's audit trail. */
function findByEvent(eventId, { limit = 100 } = {}) {
  return ModerationDecision.find({ event: eventId }).sort({ createdAt: -1 }).limit(limit).lean();
}

/** Decision rows for a set of posts, as a Map keyed by post id — used to annotate the queue. */
async function mapByPosts(postIds = []) {
  if (!postIds.length) return new Map();
  const rows = await ModerationDecision.find({ post: { $in: postIds } }).lean();
  return new Map(rows.map((row) => [row.post.toString(), row]));
}

/**
 * Claims that were taken but never settled, older than a grace period.
 *
 * The repair queue. Nothing consumes this yet — it is the read the reconciliation sweep will
 * need, and it is cheap to expose now while the reasoning is fresh. Deliberately mirrors the
 * gap wallet.service.js documents at its foot for `pending` ledger rows.
 *
 * @param {number} olderThanMs - Grace period; rows younger than this may simply be in flight.
 * @returns {Promise<Array<object>>} Stuck decisions, oldest first.
 */
function findStuck(olderThanMs = 60_000) {
  return ModerationDecision.find({
    status: 'pending',
    createdAt: { $lt: new Date(Date.now() - olderThanMs) },
  })
    .sort({ createdAt: 1 })
    .lean();
}

module.exports = { claim, findByPost, markApplied, markFailed, findByEvent, mapByPosts, findStuck };
