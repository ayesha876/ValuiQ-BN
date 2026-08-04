/**
 * post.controller.js — the thin HTTP layer for posts.
 *
 * Reads req.user (auth middleware), req.event (the event-scoped guard, already loaded and
 * access-checked) and req.validated (zodValidate). No business rules. Express 5 auto-catches
 * async errors, so no try/catch — same as event.controller.js.
 */
const postService = require('./post.service');

// GET /api/events/:eventId/arena
async function arena(req, res) {
  const data = await postService.getArena({ user: req.user, event: req.event });
  return res.status(200).json({
    success: true,
    message: 'Arena fetched successfully.',
    data,
    errors: null,
  });
}

// GET /api/events/:eventId/feed
async function feed(req, res) {
  const data = await postService.getFeed({ user: req.user, event: req.event });
  return res.status(200).json({
    success: true,
    message: 'Feed fetched successfully.',
    data,
    errors: null,
  });
}

// POST /api/events/:eventId/posts
async function create(req, res) {
  const { post, balance } = await postService.createPost({
    user: req.user,
    event: req.event,
    data: req.validated,
    // Header, not body: it describes the request rather than the post, so a replay can be
    // recognised before anything is parsed or charged. Same convention Stripe uses.
    idempotencyKey: req.headers['idempotency-key'] ?? null,
  });

  return res.status(201).json({
    success: true,
    message: 'Post submitted for review.',
    data: { post, balance },
    errors: null,
  });
}

// GET /api/events/:eventId/posts/queue   (moderators)
async function queue(req, res) {
  const posts = await postService.getReviewQueue({ event: req.event });
  return res.status(200).json({
    success: true,
    message: 'Review queue fetched successfully.',
    data: { posts },
    errors: null,
  });
}

// PATCH /api/events/:eventId/posts/:postId/review   (moderators)
async function review(req, res) {
  const post = await postService.reviewPost({
    event: req.event,
    postId: req.params.postId,
    decision: req.validated.decision,
  });

  return res.status(200).json({
    success: true,
    message: post.status === 'live' ? 'Post approved.' : 'Post rejected.',
    data: { post },
    errors: null,
  });
}

module.exports = { arena, feed, create, queue, review };
