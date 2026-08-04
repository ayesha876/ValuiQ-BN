/**
 * vote.controller.js — the thin HTTP layer for votes.
 *
 * Reads req.user, req.event (loaded by the participant guard) and req.validated. No business
 * rules; Express 5 auto-catches async errors.
 */
const voteService = require('./vote.service');

// POST /api/events/:eventId/posts/:postId/votes
async function cast(req, res) {
  const { balance, post, myStake } = await voteService.castVote({
    user: req.user,
    event: req.event,
    postId: req.params.postId,
    tokens: req.validated.tokens,
    // Header, not body — it describes the request, so a replay is recognised before charging.
    idempotencyKey: req.headers['idempotency-key'] ?? null,
  });

  return res.status(200).json({
    success: true,
    message: 'Vote cast.',
    // `post` carries the new total (the rank); `myStake` is this voter's running contribution.
    data: { balance, post: { ...post.toJSON(), myStake } },
    errors: null,
  });
}

module.exports = { cast };
