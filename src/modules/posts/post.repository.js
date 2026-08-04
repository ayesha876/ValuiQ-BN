/**
 * post.repository.js — the ONLY file that talks to the Post collection.
 *
 * The ranking query lives here, and so does the atomic stake increment. Keeping both in one
 * place is what lets "the server owns rank" stay true: there is exactly one definition of the
 * order, and no caller can accidentally invent a second one.
 */
const Post = require('./post.model');
const { DECIDABLE_STATUSES } = require('./post.model');

function create(data) {
  return Post.create(data);
}

function findById(id) {
  return Post.findById(id);
}

function findByIdempotencyKey(idempotencyKey) {
  return Post.findOne({ idempotencyKey });
}

/**
 * THE RANKING QUERY. Highest total stake first, oldest as the tiebreak.
 *
 * Only `live` posts appear: an in-review post has been paid for but not yet let through, and
 * showing it would leak the queue to everyone. Served by the { event, status, tokens, createdAt }
 * index, so this stays one indexed scan however many posts an event accumulates.
 */
function findRanked(eventId, { limit = 50, roundIndex = null } = {}) {
  const query = { event: eventId, status: 'live' };
  if (roundIndex !== null) query.roundIndex = roundIndex;

  return Post.find(query).sort({ tokens: -1, createdAt: 1 }).limit(limit).lean();
}

/** Total live posts, so a capped page can say how much it is not showing. */
function countLive(eventId, { roundIndex = null } = {}) {
  const query = { event: eventId, status: 'live' };
  if (roundIndex !== null) query.roundIndex = roundIndex;
  return Post.countDocuments(query);
}

/** One attendee's own posts for an event, newest first — including in-review ones. */
function findByAuthor(eventId, authorId) {
  return Post.find({ event: eventId, author: authorId }).sort({ createdAt: -1 }).lean();
}

/** How many this attendee has already submitted in this round — enforces submissionLimit. */
function countByAuthorInRound(eventId, authorId, roundIndex) {
  // Rejected posts still count: the tokens were spent, and not counting them would let someone
  // spend their way past the cap by having submissions turned down.
  return Post.countDocuments({ event: eventId, author: authorId, roundIndex });
}

/** The moderator review queue: what is waiting, oldest first. */
function findPending(eventId, { limit = 100 } = {}) {
  return Post.find({ event: eventId, status: 'in-review' }).sort({ createdAt: 1 }).limit(limit).lean();
}

/**
 * Move a post out of review, but ONLY from `in-review`.
 *
 * The status is part of the filter, so two moderators clicking approve at the same moment
 * cannot both succeed — the second gets null and is told it was already handled. Same
 * conditional-update idea as the wallet debit.
 */
function settleIfPending(postId, { status, approvedAt = null }) {
  return Post.findOneAndUpdate(
    { _id: postId, status: 'in-review' },
    { $set: { status, approvedAt } },
    { new: true },
  );
}

/**
 * Settle a post with a moderation OUTCOME, but only from a state that was still decidable.
 *
 * The decidable statuses are in the FILTER — same idiom as `settleIfPending` above, and the
 * same reason: two settlements racing cannot both succeed, so the second is told the post has
 * already moved on rather than overwriting the first.
 *
 * This is also what FREEZES THE STAKE SET. `addTokens` only matches `status: 'live'`, so the
 * moment this succeeds no further tokens can join the post — which is precisely why
 * moderation.service calls it before valuing anything.
 *
 * @param {string} postId - The post to settle.
 * @param {'addressed'|'dismissed'|'neglected'} status - The outcome status.
 * @returns {Promise<object|null>} The settled post, or null if it was no longer decidable.
 */
function settleDecided(postId, status) {
  return Post.findOneAndUpdate(
    { _id: postId, status: { $in: DECIDABLE_STATUSES } },
    { $set: { status } },
    { new: true },
  );
}

/**
 * Posts whose fairness deadline has passed and which nobody has settled.
 *
 * The safety net behind the BullMQ timers. Redis makes auto-neglect punctual; this query makes
 * it inevitable — it finds anything the queue never fired for, whether because Redis was down,
 * a job was lost, or the process restarted before the delay elapsed.
 *
 * Served by the { status, neglectDeadlineAt } index. Limited because a sweep that returns ten
 * thousand overdue posts should settle them over several passes rather than hold one
 * transaction-length loop open.
 *
 * @param {{now?: Date, limit?: number}} [options] - Clock override (tests) and page size.
 * @returns {Promise<Array<object>>} Overdue posts, most overdue first.
 */
function findOverdue({ now = new Date(), limit = 200 } = {}) {
  return Post.find({
    status: { $in: DECIDABLE_STATUSES },
    neglectDeadlineAt: { $ne: null, $lte: now },
  })
    .sort({ neglectDeadlineAt: 1 })
    .limit(limit)
    .lean();
}

/**
 * Add tokens to a post's running total, atomically.
 *
 * `$inc` rather than read-modify-write: many people stake on a popular post at once, and a
 * read-then-write would silently lose whichever increments landed between the two.
 */
function addTokens(postId, amount) {
  return Post.findOneAndUpdate({ _id: postId, status: 'live' }, { $inc: { tokens: amount } }, { new: true });
}

module.exports = {
  create,
  findById,
  findByIdempotencyKey,
  findRanked,
  countLive,
  findByAuthor,
  countByAuthorInRound,
  findPending,
  settleIfPending,
  settleDecided,
  findOverdue,
  addTokens,
};
