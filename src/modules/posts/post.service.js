/**
 * post.service.js — the BUSINESS LOGIC for paid posts (HTTP-agnostic).
 *
 * This is where the wallet and the realtime layer finally meet: a post costs tokens to submit,
 * waits for a moderator, and joins everyone's feed when it is let through.
 *
 * Two rules shape the whole file:
 *
 *  1. TOKENS MOVE BEFORE THE POST EXISTS. If the insert fails after the debit, the ledger
 *     holds an applied charge with no post — visible and refundable. The inverse would be a
 *     post nobody paid for, which is invisible. The idempotency key makes the retry safe, so
 *     the cost of this ordering is bounded and the benefit is auditability.
 *
 *  2. A BROADCAST CAN NEVER FAIL A DECISION. Emitting is a side effect of approving, never a
 *     precondition — the same rule the moderator bridge follows for email.
 */
const AppError = require('../../shared/utils/errors');
const authRepo = require('../auth/auth.repository');
const walletService = require('../wallet/wallet.service');
const voteRepo = require('../votes/vote.repository');
const { emitToEvent, emitToControlRoom } = require('../../sockets/socket');
const timerService = require('../moderation/timer.service');
const revenueService = require('../revenue/revenue.service');
const queueService = require('../queue/queue.service');
const repo = require('./post.repository');

// A name to show beside a post. Denormalised onto the post at creation so the feed never joins
// User per row — see displayName.js for how it is derived and why it lives in shared/ now (the
// attendee and moderator dashboards need the same answer for hosts and moderators).
const { displayNameFor } = require('../../shared/utils/displayName');

/** The stage that is live, and its configuration. Index 0 is the Opening Segment. */
function activeStage(event) {
  const index = event.currentRoundIndex ?? 0;
  if (index === 0) {
    return { index, segment: event.segment, pricing: event.pricing, shortlistSize: null };
  }
  const round = event.rounds?.[index - 1];
  if (!round) return { index, segment: event.segment, pricing: event.pricing, shortlistSize: null };
  return { index, segment: round.segment, pricing: round.pricing, shortlistSize: round.shortlistSize ?? null };
}

/**
 * When the current participation window closes.
 *
 * Null when the event has not started or the stage has no time limit — the client renders
 * nothing rather than a fabricated deadline.
 */
function windowFor(event) {
  const stage = activeStage(event);
  const minutes = stage.segment?.timeLimit;
  if (!event.roundStartedAt || !minutes) return null;

  return {
    endsAt: new Date(new Date(event.roundStartedAt).getTime() + minutes * 60_000).toISOString(),
    // The client's own clock may be minutes out; sending ours lets it correct for that
    // instead of counting down to the wrong moment.
    serverNow: new Date().toISOString(),
  };
}

/** Everything the attendee screen needs to render, in one round trip. */
async function getArena({ user, event }) {
  const stage = activeStage(event);
  const [balance, myPosts] = await Promise.all([
    walletService.getBalance(user.id),
    repo.findByAuthor(event.id, user.id),
  ]);

  return {
    event,
    me: {
      userId: user.id,
      balance,
      posts: myPosts.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest })),
    },
    window: windowFor(event),
    currentRound: { index: stage.index, shortlistSize: stage.shortlistSize },
  };
}

/**
 * Submit a post, paying for it.
 *
 * Everything that can be refused is refused BEFORE any tokens move — a rejected submission
 * must never cost anything.
 */
async function createPost({ user, event, data, idempotencyKey = null }) {
  // A retried request returns the post it already made rather than paying for a second one.
  if (idempotencyKey) {
    const existing = await repo.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { post: existing, balance: await walletService.getBalance(user.id), replayed: true };
    }
  }

  if (event.status !== 'live') {
    throw new AppError(409, 'This event is not accepting posts right now.');
  }

  const stage = activeStage(event);
  const minPostCost = stage.pricing?.minPostCost ?? 0;
  const tokens = data.tokens;

  if (tokens < minPostCost) {
    throw new AppError(400, `The minimum to post is ${minPostCost} tokens.`);
  }

  // N — max submissions per attendee in this stage. Configured since Week 1 and, until now,
  // enforced nowhere: a host who set N=3 got unlimited.
  const cap = stage.segment?.submissionLimit;
  if (cap) {
    const already = await repo.countByAuthorInRound(event.id, user.id, stage.index);
    if (already >= cap) {
      throw new AppError(409, `You have used all ${cap} of your submissions for this round.`);
    }
  }

  // Pay. Throws 409 "Not enough tokens for this." — already worded for a person.
  const { balance } = await walletService.debit({
    userId: user.id,
    amount: tokens,
    type: 'post',
    idempotencyKey,
    ref: { eventId: event.id },
  });

  // req.user carries only { id, role } from the token, so the name comes from the record.
  const author = await authRepo.findById(user.id);

  // The fairness clock starts HERE, at submission, not at approval. A post nobody ever
  // reviewed is exactly the case auto-neglect exists to refund, so the deadline cannot wait
  // for a moderator to act. Frozen onto the post so a later edit to the host's `neglectTimer`
  // cannot move a deadline attendees were already shown.
  const neglectDeadlineAt = timerService.deadlineFor(event, stage.index);

  const post = await repo.create({
    event: event.id,
    author: user.id,
    authorName: displayNameFor(author),
    text: data.text,
    tokens,
    // What the author themselves staked. `tokens` grows with every backer; this does not.
    openingStake: tokens,
    status: 'in-review',
    roundIndex: stage.index,
    idempotencyKey,
    neglectDeadlineAt,
  });

  // Arm the timer. Best-effort and never awaited into the failure path: without Redis this is
  // a no-op and the worker's database sweep settles the post from `neglectDeadlineAt` instead.
  // A scheduling problem must never fail a post the attendee has already paid for.
  timerService
    .schedule({ postId: post.id, eventId: event.id, deadlineAt: neglectDeadlineAt })
    .catch((err) => console.warn('[posts] Fairness timer not scheduled (sweep will catch it):', err.message));

  // Tell the moderators a post is waiting. Emitted immediately rather than batched: a review
  // queue that lags is a queue whose neglect timers are already running down.
  //
  // Everyone in the event room receives this, but only the Control Room subscribes — and the
  // queue endpoint behind it is moderator-only, so an attendee learning that *a* post exists
  // reveals nothing they could not work out by watching the feed.
  //
  // Best-effort, like every other broadcast here: a socket problem must never fail a paid post.
  try {
    emitToEvent(event.id, 'post:pending', { post: post.toJSON() });
  } catch (err) {
    console.warn('[posts] Pending broadcast failed (post still saved):', err.message);
  }

  // The control room gets the QUEUE-SHAPED row instead — the same object the REST queue
  // endpoint returns, so a client rendering a live arrival and a client rendering a page of
  // the queue can never disagree about what a row looks like. Moderators only: it carries the
  // post's financial exposure, which `post:pending` above deliberately does not.
  //
  // Deliberately NOT awaited. Valuing the post is a wallet aggregate, and an attendee pressing
  // Post should not wait on a query that exists to decorate someone else's dashboard. Fired
  // after the response is already on its way, and swallowed if it fails.
  (async () => {
    const valuation = await revenueService.valuePost(post);
    emitToControlRoom(event.id, 'queue:post_added', {
      item: queueService.shapeRow(post.toObject(), valuation, Date.now()),
      at: new Date().toISOString(),
    });
  })().catch((err) => console.warn('[posts] Queue broadcast failed (post still saved):', err.message));

  return { post, balance, replayed: false };
}

/** What is waiting for a moderator, oldest first. */
async function getReviewQueue({ event }) {
  const posts = await repo.findPending(event.id);
  return posts.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest }));
}

/**
 * Let a post through, or turn it down.
 *
 * Approving emits TWO events, deliberately separate: the author's own copy changes status, and
 * the post joins the feed for everyone. The frontend listens for both and does different
 * things with each.
 */
async function reviewPost({ event, postId, decision }) {
  const post = await repo.findById(postId);
  if (!post) throw new AppError(404, 'Post not found.');
  if (post.event.toString() !== event.id.toString()) {
    // Belongs to a different event — treat as not found rather than confirming it exists.
    throw new AppError(404, 'Post not found.');
  }

  const status = decision === 'approve' ? 'live' : 'rejected';
  const settled = await repo.settleIfPending(postId, {
    status,
    approvedAt: status === 'live' ? new Date() : null,
  });

  // Null means it was not in review — almost always a second moderator a moment behind.
  if (!settled) throw new AppError(409, 'That post has already been reviewed.');

  // Best-effort from here: a broadcast problem must never undo a moderator's decision.
  try {
    emitToEvent(event.id, 'post:status', { postId: settled.id, status: settled.status });

    if (status === 'live') {
      const ranked = await repo.findRanked(event.id, { limit: 50 });
      emitToEvent(event.id, 'post:new', {
        post: { ...settled.toJSON(), myStake: 0 },
        order: ranked.map((p) => p._id.toString()),
      });
    }
  } catch (err) {
    console.warn('[posts] Broadcast failed (decision still stands):', err.message);
  }

  return settled;
}

/**
 * The ranked feed, plus what this viewer has personally staked on each post.
 *
 * SERVER-RANKED. The order in `posts` IS the ranking; the client renders it verbatim and never
 * sorts. `total` lets a capped page say how much it is not showing, so a truncated feed never
 * reads as the whole event.
 *
 * The page is capped rather than paginated: rank means the interesting posts are at the top by
 * definition, so the tail costs payload and DOM for almost no value. Infinite scroll can be
 * added later if an event ever needs it.
 */
async function getFeed({ user, event, limit = 50 }) {
  const stage = activeStage(event);

  const [ranked, total, myStakes] = await Promise.all([
    repo.findRanked(event.id, { limit }),
    repo.countLive(event.id),
    voteRepo.stakesByVoter(event.id, user.id),
  ]);

  return {
    posts: ranked.map(({ _id, __v, author, ...rest }) => ({
      id: _id.toString(),
      ...rest,
      // "You" badge and the "You spent N on this post" line. Comparing here rather than
      // sending the raw author id keeps other people's user ids out of the response.
      isMine: author.toString() === String(user.id),
      myStake: myStakes.get(_id.toString()) ?? 0,
    })),
    total,
    minVoteCost: stage.pricing?.minVoteCost ?? 0,
    // Where the shortlist cut falls, or null when this stage has no cut (the Opening Segment
    // has no shortlistSize — everyone competes and round 1 applies the first filter).
    shortlistSize: stage.shortlistSize,
  };
}

module.exports = { getArena, getFeed, createPost, getReviewQueue, reviewPost, activeStage, windowFor };
