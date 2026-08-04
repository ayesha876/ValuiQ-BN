/**
 * vote.service.js — backing a post with tokens.
 *
 * Three writes happen, in this order, and the order is the design:
 *
 *   1. DEBIT the wallet (idempotent, atomic, refuses if unaffordable)
 *   2. ADD to the post's total    — this is the rank
 *   3. ADD to the voter's stake   — this is "You spent N on this post"
 *
 * Money first, for the same reason as posts: a charge with no stake recorded is visible in the
 * ledger and fixable, whereas a stake nobody paid for is invisible and inflates a ranking that
 * decides who gets answered.
 *
 * THE SERVER OWNS RANK. Nothing here tells a client where a post now sits — the reorder goes
 * out in the next batched broadcast, so every client moves at the same moment rather than each
 * guessing locally and disagreeing.
 */
const AppError = require('../../shared/utils/errors');
const walletService = require('../wallet/wallet.service');
const postRepo = require('../posts/post.repository');
const { queueFeedChange } = require('../../sockets/feedBroadcaster');
const repo = require('./vote.repository');

/** The stage that is live, and what it costs to back a post in it. */
function minVoteCostFor(event) {
  const index = event.currentRoundIndex ?? 0;
  if (index === 0) return event.pricing?.minVoteCost ?? 0;
  return event.rounds?.[index - 1]?.pricing?.minVoteCost ?? event.pricing?.minVoteCost ?? 0;
}

/**
 * Rebuild the current ranking and hand it to the broadcaster.
 *
 * Deliberately re-read at SEND time rather than computed when the vote landed: by the time a
 * batch goes out, other stakes have usually arrived too, and the order clients receive should
 * be the one that is true now.
 */
async function resolveFeedDeltas(eventId, changedPostIds) {
  const ranked = await postRepo.findRanked(eventId, { limit: 50 });
  const changed = new Set(changedPostIds.map(String));

  return {
    changed: ranked
      .filter((post) => changed.has(post._id.toString()))
      .map((post) => ({ id: post._id.toString(), tokens: post.tokens })),
    order: ranked.map((post) => post._id.toString()),
  };
}

/**
 * Back a post with tokens.
 *
 * Voting on your own post is allowed — the design shows an Upvote button on the "You" card,
 * and boosting your own question is a legitimate way to spend tokens.
 */
async function castVote({ user, event, postId, tokens, idempotencyKey = null }) {
  if (event.status !== 'live') {
    throw new AppError(409, 'This event is not accepting votes right now.');
  }

  const minVoteCost = minVoteCostFor(event);
  if (tokens < minVoteCost) {
    throw new AppError(400, `The minimum stake is ${minVoteCost} tokens.`);
  }

  const post = await postRepo.findById(postId);
  if (!post || post.event.toString() !== event.id.toString()) {
    throw new AppError(404, 'Post not found.');
  }
  // Only a post that has cleared review can be backed: an in-review post is not visible to
  // anyone else, so staking on it would be spending on something nobody can see.
  if (post.status !== 'live') {
    throw new AppError(409, 'That post is not open for votes.');
  }

  // Pay first. Throws 409 "Not enough tokens for this." — already worded for a person.
  const { balance, replayed } = await walletService.debit({
    userId: user.id,
    amount: tokens,
    type: 'vote',
    idempotencyKey,
    ref: { eventId: event.id, postId: post.id },
  });

  // A replayed request already moved these tokens on its first pass; applying the stake again
  // would inflate the post's total every time a client retried.
  if (replayed) {
    const existing = await repo.findByPostAndVoter(post.id, user.id);
    const current = await postRepo.findById(post.id);
    return { balance, post: current, myStake: existing?.tokens ?? 0, replayed: true };
  }

  const updated = await postRepo.addTokens(post.id, tokens);
  const stake = await repo.addStake({
    postId: post.id,
    voterId: user.id,
    eventId: event.id,
    amount: tokens,
  });

  // Tell everyone — eventually, and in one message with everything else that just changed.
  queueFeedChange(event.id, [post.id], resolveFeedDeltas);

  return { balance, post: updated ?? post, myStake: stake.tokens, replayed: false };
}

module.exports = { castVote, minVoteCostFor, resolveFeedDeltas };
