/**
 * vote.repository.js — the ONLY file that talks to the Vote collection.
 */
const Vote = require('./vote.model');

/**
 * Add to this voter's stake on this post, creating the row on first backing.
 *
 * `$inc` with `upsert` in one call: two simultaneous stakes from the same person accumulate
 * correctly instead of one overwriting the other, and neither has to check first. `$setOnInsert`
 * fills the immutable fields only when the row is actually created.
 */
function addStake({ postId, voterId, eventId, amount }) {
  return Vote.findOneAndUpdate(
    { post: postId, voter: voterId },
    { $inc: { tokens: amount }, $setOnInsert: { event: eventId } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

/** This voter's stakes across one event, as a Map of postId -> tokens. */
async function stakesByVoter(eventId, voterId) {
  const rows = await Vote.find({ event: eventId, voter: voterId }).lean();
  return new Map(rows.map((row) => [row.post.toString(), row.tokens]));
}

function findByPostAndVoter(postId, voterId) {
  return Vote.findOne({ post: postId, voter: voterId });
}

/**
 * Everyone who backed one post, and how much each of them has behind it.
 *
 * This is the refund list. When a post is neglected, "attendees are fully refunded" means
 * every one of these people gets their own number back — not an even split of the post's
 * total, which would take from the person who staked most and hand it to the person who
 * staked least.
 *
 * Note the AUTHOR IS NOT HERE. Their opening stake is `post.tokens` minus these, and it lives
 * on the post rather than in a Vote row. The moderation service adds them; getting that wrong
 * means the person who started the thread is the only one not refunded.
 *
 * Served by the { post, voter } unique index.
 *
 * @param {string|import('mongoose').Types.ObjectId} postId - The post being settled.
 * @returns {Promise<Array<{voter: object, tokens: number}>>} One row per backer.
 */
function stakersForPost(postId) {
  return Vote.find({ post: postId, tokens: { $gt: 0 } })
    .select('voter tokens')
    .lean();
}

module.exports = { addStake, stakesByVoter, findByPostAndVoter, stakersForPost };
