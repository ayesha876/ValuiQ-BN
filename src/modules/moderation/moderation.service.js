/**
 * moderation.service.js — the BUSINESS LOGIC for settling a post (HTTP-agnostic).
 *
 * This is where a paid post stops being a question and becomes money: the host's earnings, or
 * the audience's refund. It is the most consequential file in the codebase, and every ordering
 * choice below exists to make one guarantee hold —
 *
 *   ⚠️ NO ATTENDEE IS EVER REFUNDED TWICE, AND NO HOST IS EVER PAID TWICE.
 *
 * ── HOW, WITHOUT A TRANSACTION ────────────────────────────────────────────────────────────
 * There are no Mongo transactions here (wallet.service.js explains the standing reason: they
 * need a replica set the test runner does not provide). Instead the settlement is built so
 * that RUNNING IT TWICE IS INDISTINGUISHABLE FROM RUNNING IT ONCE:
 *
 *   1. CLAIM   — insert a ModerationDecision. Its unique index on `post` means exactly one
 *                caller proceeds; every other caller, retry, and racing worker is handed the
 *                winner's row instead.
 *   2. FREEZE  — settle the post's status. This is what stops new stakes landing mid-refund
 *                (see the comment at the call site — it is not cosmetic ordering).
 *   3. VALUE   — read the now-frozen stake set and price it per staker.
 *   4. SETTLE  — book revenue, or refund. Every money write carries a DETERMINISTIC
 *                idempotency key derived from the post and user, so a re-run is a no-op.
 *   5. RECORD  — mark the decision applied with what it actually cost.
 *
 * A crash anywhere after step 1 leaves a `pending` decision naming the post and the intended
 * outcome. Re-running it completes only what is missing. That is a stronger property than
 * all-or-nothing: a transaction protects one attempt, this protects every retry.
 *
 * ── WHY THE BROADCAST IS LAST AND CANNOT FAIL ─────────────────────────────────────────────
 * Publishing happens after the money is settled and is wrapped so it can never throw into the
 * decision path. Same rule posts, votes, and the moderator bridge already follow: telling
 * people about a thing is a side effect of the thing, never a precondition for it.
 */
const AppError = require('../../shared/utils/errors');
const postRepo = require('../posts/post.repository');
const revenueService = require('../revenue/revenue.service');
const { OUTCOME_STATUS, DECIDABLE_STATUSES } = require('../posts/post.model');
const { HOST_SHARE_PCT, REFUNDS_STAKERS } = require('./moderation.model');
const { publish, EVENTS } = require('../../shared/events/bus');
const { emitToEvent, emitToControlRoom } = require('../../sockets/socket');
const { createLogger } = require('../../shared/utils/logger');
const timerService = require('./timer.service');
const repo = require('./moderation.repository');

const log = createLogger('moderation');

/**
 * Settle a post's status, but ONLY from a state that was still decidable.
 *
 * The status list is in the FILTER, exactly as `post.repository.settleIfPending` puts it there
 * for the approve/reject gate. Returns null when the post had already moved on.
 */
function freezePost(postId, decision) {
  return postRepo.settleDecided(postId, OUTCOME_STATUS[decision]);
}

/**
 * Everything the caller gets back about a settled post.
 *
 * Shaped once, here, so the REST response, the socket payload, and the worker's log all
 * describe an outcome the same way.
 */
function shapeOutcome({ post, decision, financials }) {
  return {
    post: typeof post.toJSON === 'function' ? post.toJSON() : post,
    decision: {
      id: decision.id ?? decision._id?.toString(),
      decision: decision.decision,
      source: decision.source,
      reason: decision.reason ?? '',
      appliedAt: decision.appliedAt ? new Date(decision.appliedAt).toISOString() : null,
    },
    financials: {
      // Real money the host earned, in cents.
      hostEarnedCents: financials.hostEarnedCents ?? 0,
      // Full realised value before the host's share — "you earned 1500 of a possible 3000".
      grossValueCents: financials.grossValueCents ?? 0,
      // In-app tokens handed back. Zero for anything but neglect.
      refundedTokens: financials.refundedTokens ?? 0,
      stakerCount: financials.stakerCount ?? 0,
    },
  };
}

/**
 * Load a post and prove it is this event's, or say it does not exist.
 *
 * A post from another event reads as 404 rather than 403 — confirming it exists to a moderator
 * who has no business with it is the existence disclosure the events module already avoids.
 */
async function loadPostForEvent(eventId, postId) {
  let post;
  try {
    post = await postRepo.findById(postId);
  } catch (err) {
    // A malformed id is a client problem. The shared handler maps CastError to 400, but being
    // explicit here keeps the 404-vs-400 boundary in one readable place.
    if (err.name === 'CastError') throw new AppError(400, 'Invalid post id.');
    throw err;
  }

  if (!post || post.event.toString() !== String(eventId)) {
    throw new AppError(404, 'Post not found.');
  }
  return post;
}

/**
 * Replay an existing decision instead of applying a new one.
 *
 * The distinction that matters: retrying the SAME decision is a retry and must succeed with
 * the original numbers; asking for a DIFFERENT one is a conflict and must be refused. Both
 * arrive here identically — as a lost claim — and only the requested outcome tells them apart.
 *
 * Mirrors `wallet.service.replayIfKnown`, including its refusal to answer while a decision is
 * still `pending`: we cannot yet say what it cost, and guessing would report a refund that may
 * not have happened.
 */
async function replayDecision({ existing, requested, postId }) {
  if (!existing) {
    // The index slot is taken but the winner's document is not readable yet. Contended and
    // unknown — never retry the claim from here.
    throw new AppError(409, 'This post is already being decided. Please try again in a moment.');
  }

  if (existing.decision !== requested) {
    throw new AppError(
      409,
      `This post has already been ${OUTCOME_STATUS[existing.decision]}. A second decision cannot be applied.`,
    );
  }

  if (existing.status === 'pending') {
    throw new AppError(409, 'This decision is still being applied. Please try again in a moment.');
  }

  if (existing.status === 'failed') {
    // Honest rather than convenient: the claim exists, the money did not fully settle, and
    // pretending otherwise would report a refund nobody received.
    throw new AppError(409, 'A previous attempt at this decision did not complete. It needs review before it can be retried.');
  }

  const post = await postRepo.findById(postId);
  log.info('Replaying an already-applied decision', { postId, decision: requested });

  return {
    ...shapeOutcome({ post, decision: existing, financials: existing }),
    replayed: true,
  };
}

/**
 * ⚠️ THE DECISION. Apply Address / Dismiss / Neglect to a post, once and only once.
 *
 * @param {object} input
 * @param {object} input.event - The loaded event (from requireEventModerator).
 * @param {string} input.postId - Post being decided.
 * @param {'address'|'dismiss'|'neglect'} input.decision - The outcome.
 * @param {string|null} [input.moderatorId] - Who decided. Required unless source is 'system'.
 * @param {string} [input.reason] - Optional free text shown in the audit trail.
 * @param {'moderator'|'system'} [input.source] - 'system' only from the fairness worker.
 * @returns {Promise<{post: object, decision: object, financials: object, replayed: boolean}>}
 * @throws {AppError} 404 post not found · 409 already decided · 422 not in a decidable state
 *
 * @example
 * await applyDecision({ event, postId, decision: 'address', moderatorId: req.user.id });
 */
async function applyDecision({ event, postId, decision, moderatorId = null, reason = '', source = 'moderator' }) {
  const eventId = event._id ?? event.id;
  const post = await loadPostForEvent(eventId, postId);

  // ── NOBODY SETTLES THEIR OWN POST ───────────────────────────────────────────────────────
  // `requireEventModerator` proves you may decide posts in this event; it says nothing about
  // WHOSE post. Both moderator roles can also be authors — the host may post into their own
  // event, and an EventMember is an ordinary attendee with a badge — so without this check a
  // moderator can settle the post they wrote themselves.
  //
  // That is not a hypothetical tidy-up. On Address, the OTHER people who staked on that post
  // have their tokens converted into the host's earnings instead of being refunded, and the
  // person who chose that outcome is the one whose post it is. The self-dealing is invisible
  // afterwards, because the audit trail records a legitimate moderator taking a legitimate
  // decision.
  //
  // 403, not 409: the decision is well-formed and the post is decidable — the caller is simply
  // not allowed to be the one who takes it. `source: 'system'` is exempt by construction, since
  // the fairness worker has no identity to collide with the author's.
  if (source === 'moderator' && moderatorId && String(post.author) === String(moderatorId)) {
    throw new AppError(
      403,
      'You cannot decide your own post. Another moderator has to settle it.',
    );
  }

  // A post that has already been settled, or was rejected at the publication gate, is not a
  // conflict to be resolved — it is simply not a thing a decision can be taken on. 422 says
  // "understood, but wrong state", which is exactly the case.
  if (!DECIDABLE_STATUSES.includes(post.status)) {
    const existing = await repo.findByPost(postId);
    if (existing) return replayDecision({ existing, requested: decision, postId });

    throw new AppError(
      422,
      `A post that is "${post.status}" cannot be decided. Only posts awaiting review or live in the feed can be settled.`,
    );
  }

  // ── 1. CLAIM ────────────────────────────────────────────────────────────────────────────
  const { claimed, decision: claim } = await repo.claim({
    post: postId,
    event: eventId,
    decision,
    source,
    moderator: source === 'system' ? null : moderatorId,
    reason,
  });

  if (!claimed) return replayDecision({ existing: claim, requested: decision, postId });

  try {
    // ── 2. FREEZE ─────────────────────────────────────────────────────────────────────────
    // ⚠️ THIS MUST HAPPEN BEFORE VALUATION, AND IT IS NOT ORDERING PEDANTRY.
    //
    // While a post is `live`, anyone can still stake on it. `postRepo.addTokens` filters on
    // `status: 'live'`, so moving the post out of `live` is what closes that door. Valuing
    // first and settling after would leave a window in which a stake lands, is charged for,
    // and is then never included in the refund set — the attendee pays and gets nothing back.
    const settled = await freezePost(postId, decision);

    if (!settled) {
      // Someone settled it between the status check and here. The claim is ours, but the post
      // is not in the state we priced — release the claim so the real winner's decision stands
      // rather than recording an outcome we never applied.
      await repo.markFailed(claim.id);
      const existing = await repo.findByPost(postId);
      return replayDecision({ existing, requested: decision, postId });
    }

    // ── 3. VALUE (the stake set is now frozen) ────────────────────────────────────────────
    const valuation = await revenueService.valuePost(settled);

    // ── 4. SETTLE ─────────────────────────────────────────────────────────────────────────
    let financials = { hostEarnedCents: 0, grossValueCents: valuation.totalCents, refundedTokens: 0, stakerCount: 0 };

    if (REFUNDS_STAKERS[decision]) {
      const reversal = await revenueService.reverseHostRevenue({ post: settled, event, valuation });
      financials = {
        hostEarnedCents: 0,
        grossValueCents: reversal.grossValueCents,
        refundedTokens: reversal.refundedTokens,
        stakerCount: reversal.stakerCount,
      };
    } else {
      const booking = await revenueService.bookHostRevenue({
        post: settled,
        event,
        decisionPct: HOST_SHARE_PCT[decision],
        valuation,
      });
      financials = {
        hostEarnedCents: booking.amountCents,
        grossValueCents: booking.grossValueCents,
        refundedTokens: 0,
        stakerCount: valuation.perStaker.length,
      };
    }

    // ── 5. RECORD ─────────────────────────────────────────────────────────────────────────
    const applied = (await repo.markApplied(claim.id, financials)) ?? claim;

    log.info('Decision applied', {
      postId,
      eventId,
      decision,
      source,
      moderatorId,
      ...financials,
    });

    const outcome = shapeOutcome({ post: settled, decision: applied, financials });

    // ── 6. TELL EVERYONE (best-effort, never load-bearing) ────────────────────────────────
    announce({ event, outcome, decision, source });

    // The post has left the queue, so its fairness timer is no longer wanted. Best-effort:
    // even if removal fails, the worker re-checks state and finds the post undecidable, so a
    // surviving job is a no-op rather than a second refund.
    timerService.cancel(postId).catch((err) => log.warn('Timer cancel failed (job will no-op)', { postId, err }));

    return { ...outcome, replayed: false };
  } catch (err) {
    // The claim was taken but settlement did not finish. Marking it failed keeps the post's
    // decision slot occupied — deliberately. A post whose refunds half-happened must not be
    // silently re-decidable into a second set; clearing it is an explicit repair action.
    await repo.markFailed(claim.id).catch(() => {});
    log.error('Settlement failed after the claim was taken', { postId, eventId, decision, err });
    throw err;
  }
}

/**
 * Publish the decision everywhere it needs to go.
 *
 * Two channels on purpose: the DOMAIN BUS reaches other instances (and the fairness worker),
 * while `emitToEvent` reaches the sockets held by this one. Wrapped whole — a broadcast
 * problem must never surface as a failed decision to the moderator who took it.
 */
function announce({ event, outcome, decision, source }) {
  const eventId = String(event._id ?? event.id);
  const payload = {
    eventId,
    postId: outcome.post.id ?? outcome.post._id,
    decision,
    source,
    financials: outcome.financials,
    at: new Date().toISOString(),
  };

  try {
    publish(source === 'system' ? EVENTS.DECISION_AUTO_NEGLECT : EVENTS.DECISION_APPLIED, payload);

    // The post has left the review queue — every control room watching this event must drop
    // it. MODERATORS ONLY: this payload carries what the post was worth, which is not an
    // attendee's business.
    emitToControlRoom(eventId, 'queue:post_removed', {
      postId: payload.postId,
      decision,
      source,
      financials: outcome.financials,
    });

    // The author's own view of their post changes too, and that IS everyone's business — the
    // status is already visible in the feed. No financials here.
    emitToEvent(eventId, 'post:status', { postId: payload.postId, status: outcome.post.status });
  } catch (err) {
    log.warn('Broadcast failed (decision still stands)', { postId: payload.postId, err });
  }
}

/**
 * The decision on a post, if one has been taken.
 *
 * @param {string} postId - The post.
 * @returns {Promise<object|null>} The decision, or null.
 */
function getDecision(postId) {
  return repo.findByPost(postId);
}

/**
 * One event's decision history, newest first.
 *
 * @param {string} eventId - The event.
 * @param {{limit?: number}} [options] - Page size.
 * @returns {Promise<Array<object>>} Decisions, newest first.
 */
function getEventHistory(eventId, options) {
  return repo.findByEvent(eventId, options);
}

module.exports = { applyDecision, getDecision, getEventHistory };
