/**
 * revenue.service.js — turning tokens into a host's real money (HTTP-agnostic).
 *
 * Called only by moderation.service, once a decision has been claimed. It never decides
 * anything itself: it is handed an outcome and works out what that outcome is worth.
 *
 * ── THE ONE IDEA THAT MATTERS ─────────────────────────────────────────────────────────────
 * A post is not worth `post.tokens × some rate`. It is worth the SUM of what each individual
 * staker paid for the tokens they put behind it. Two people can each stake 100 tokens on the
 * same post and be worth very different amounts of real money, because they bought at
 * different package rates (QinMvpDocs §6). So every calculation here is per-staker, then
 * summed — never post-level, then divided.
 *
 * That is also why refunds are per-staker. Neglect returns each person's own tokens, not an
 * even split of the post's total, which would quietly take from whoever staked most.
 */
const AppError = require('../../shared/utils/errors');
const walletRepo = require('../wallet/wallet.repository');
const walletService = require('../wallet/wallet.service');
const voteRepo = require('../votes/vote.repository');
const { createLogger } = require('../../shared/utils/logger');
const {
  centsPerToken,
  hostShareCents,
  valuePostStakes,
} = require('../../shared/utils/tokenValueCalculator');
const repo = require('./revenue.repository');

const log = createLogger('revenue');

/**
 * Everyone with tokens behind a post, including the author.
 *
 * THE AUTHOR IS NOT A VOTE ROW. Their opening stake never created one — `post.tokens` starts
 * at it and grows by every backer since. So the author's own stake is the post total minus the
 * votes, and forgetting that means the person who wrote the post is the only one not refunded
 * when it is neglected.
 *
 * Clamped at zero because the subtraction must never go negative: if vote rows somehow
 * out-total the post (a lost `$inc` on the post, say), a negative author stake would become a
 * negative refund, which is a debit dressed as a credit.
 *
 * @param {object} post - The post being settled.
 * @returns {Promise<Array<{userId: string, tokens: number}>>} Every staker and their tokens.
 */
async function stakeholdersFor(post) {
  const votes = await voteRepo.stakersForPost(post._id ?? post.id);

  const backers = votes.map((vote) => ({
    userId: vote.voter.toString(),
    tokens: vote.tokens,
  }));

  // Prefer the recorded opening stake. The subtraction is only a fallback for posts written
  // before `openingStake` existed — see the field's comment in post.model.js for why it is
  // not trustworthy on its own.
  const backed = backers.reduce((sum, stake) => sum + stake.tokens, 0);
  const authorStake =
    post.openingStake != null ? post.openingStake : Math.max((post.tokens ?? 0) - backed, 0);

  const authorId = (post.author?._id ?? post.author).toString();

  // The author may ALSO have voted on their own post. Merging rather than pushing a second row
  // keeps one entry per person, so their refund is one credit and their rate is looked up once.
  const existing = backers.find((stake) => stake.userId === authorId);
  if (existing) existing.tokens += authorStake;
  else if (authorStake > 0) backers.push({ userId: authorId, tokens: authorStake });

  return backers;
}

/**
 * What a post is worth in real money right now, broken down by staker.
 *
 * Exposed rather than kept private because the review queue needs exactly this number to show
 * a moderator the FINANCIAL EXPOSURE of leaving a post undecided — and computing it a second
 * way for the queue is how two answers to one question get shipped.
 *
 * @param {object} post - The post to value.
 * @returns {Promise<{totalTokens: number, totalCents: number, perStaker: Array<{userId: string, tokens: number, cents: number}>}>}
 *
 * @example
 * const { totalCents } = await valuePost(post); // 3000 => $30.00 at risk
 */
async function valuePost(post) {
  const stakes = await stakeholdersFor(post);
  if (!stakes.length) return { totalTokens: 0, totalCents: 0, perStaker: [] };

  const totals = await walletRepo.purchaseTotalsByUsers(stakes.map((s) => s.userId));

  // A staker with no purchase history is absent from the map and resolves to a zero rate —
  // correct, not a gap: nobody paid real money, so there is no real money to book.
  const rates = new Map(stakes.map((s) => [s.userId, centsPerToken(totals.get(s.userId))]));

  return valuePostStakes(stakes, rates);
}

/**
 * Book a host's earnings for a settled post.
 *
 * Called on Address (100%) and Dismiss (50%). Idempotent by the unique index on
 * `HostRevenueEntry.post`: a replay finds the existing entry and credits nothing further, so
 * a retried decision cannot pay a host twice.
 *
 * ORDER: write the entry, THEN credit the wallet. Same reasoning as the token ledger — a crash
 * between the two leaves an entry with no matching balance, which is visible and repairable by
 * summing entries. The inverse leaves a balance nobody can explain.
 *
 * @param {object} input
 * @param {object} input.post - The settled post.
 * @param {object} input.event - Its event, for `revenueSharePct` and the owner.
 * @param {number} input.decisionPct - 100 for Address, 50 for Dismiss.
 * @param {{totalCents: number}} [input.valuation] - Pre-computed valuation, to avoid re-reading.
 * @returns {Promise<{amountCents: number, grossValueCents: number, entry: object|null, alreadyBooked: boolean}>}
 *
 * @example
 * await bookHostRevenue({ post, event, decisionPct: 100 }); // Address
 */
async function bookHostRevenue({ post, event, decisionPct, valuation = null }) {
  const value = valuation ?? (await valuePost(post));
  const sharePct = event.revenueSharePct ?? 100;
  const amountCents = hostShareCents(value.totalCents, sharePct, decisionPct);

  const postId = post._id ?? post.id;
  const hostId = (event.owner?._id ?? event.owner).toString();

  // A zero-value post is the norm before Stripe lands: every token is a dev grant, so nothing
  // real was paid and nothing real is owed. Writing a 0-cent entry would fill the ledger with
  // rows that mean "no money" — the decision record already says the post was addressed.
  if (amountCents <= 0) {
    log.debug('Nothing to book — post realised no real money', {
      postId,
      grossValueCents: value.totalCents,
    });
    return { amountCents: 0, grossValueCents: value.totalCents, entry: null, alreadyBooked: false };
  }

  const { created, entry } = await repo.bookEntry({
    host: hostId,
    event: event._id ?? event.id,
    post: postId,
    decision: decisionPct === 100 ? 'address' : 'dismiss',
    grossValueCents: value.totalCents,
    sharePct,
    decisionPct,
    amountCents,
  });

  if (!created) {
    // A retry. The wallet was credited when the entry was first written; crediting again is
    // exactly the double-pay this index exists to stop.
    log.info('Revenue already booked for this post — replaying', { postId, amountCents: entry?.amountCents });
    return {
      amountCents: entry?.amountCents ?? 0,
      grossValueCents: entry?.grossValueCents ?? value.totalCents,
      entry,
      alreadyBooked: true,
    };
  }

  await repo.creditWallet(hostId, amountCents);

  log.info('Host revenue booked', { postId, hostId, amountCents, grossValueCents: value.totalCents, sharePct, decisionPct });
  return { amountCents, grossValueCents: value.totalCents, entry, alreadyBooked: false };
}

/**
 * Reverse a host's earnings for a post, and refund every staker.
 *
 * Called on Neglect. Two independent halves, in this order:
 *
 *   1. VOID any booked revenue and claw it back. A post can be neglected after being addressed
 *      only if a decision was cleared by hand, so this is usually a no-op — but "usually" is
 *      not a guarantee, and skipping it would leave a host paid for a post that was refunded.
 *   2. REFUND every staker their exact tokens.
 *
 * Refunds go through `walletService.credit` rather than the repository so they land in the
 * ledger like every other movement — one door for money, one place to audit.
 *
 * ⚠️ IDEMPOTENCY IS THE KEY, LITERALLY. Each refund uses a DETERMINISTIC key,
 * `neglect:<postId>:<userId>`. Re-running this function — a retry, a crash mid-loop, the
 * fairness worker racing a moderator — recomputes the same keys, and the unique index on
 * `LedgerEntry.idempotencyKey` refuses the second write. Partial completion is therefore safe
 * to simply re-run: the refunds that happened are skipped, the ones that did not are made.
 * This is what makes a multi-step settlement safe without a transaction.
 *
 * @param {object} input
 * @param {object} input.post - The neglected post.
 * @param {object} input.event - Its event.
 * @param {{perStaker: Array<{userId: string, tokens: number}>}} [input.valuation] - Pre-computed.
 * @returns {Promise<{refundedTokens: number, stakerCount: number, reversedCents: number, grossValueCents: number}>}
 *
 * @example
 * await reverseHostRevenue({ post, event }); // every staker made whole, host earns nothing
 */
async function reverseHostRevenue({ post, event, valuation = null }) {
  const value = valuation ?? (await valuePost(post));
  const postId = post._id ?? post.id;
  const hostId = (event.owner?._id ?? event.owner).toString();

  // ── 1. Claw back any revenue already booked against this post ──────────────────────────
  let reversedCents = 0;
  const voided = await repo.voidEntryForPost(postId);
  if (voided) {
    reversedCents = voided.amountCents;
    const wallet = await repo.debitWalletIfSufficient(hostId, reversedCents);
    if (!wallet) {
      // The host no longer holds enough pending balance — they have been paid out since. The
      // entry is still voided (it is genuinely not earned), and this is logged loudly rather
      // than forced, because driving a balance negative to make the books tidy is worse than
      // a discrepancy someone can see and settle against the payout.
      log.error('Voided revenue exceeded the host pending balance — clawback not taken', {
        postId,
        hostId,
        reversedCents,
      });
    }
  }

  // ── 2. Refund every staker their own tokens ────────────────────────────────────────────
  let refundedTokens = 0;
  let stakerCount = 0;

  for (const stake of value.perStaker) {
    if (stake.tokens <= 0) continue;
    try {
      // Sequential, not Promise.all: these are wallet writes, and a burst of concurrent
      // credits against the same collection buys nothing on a post with a handful of backers
      // while making a partial failure much harder to reason about.
      await walletService.credit({
        userId: stake.userId,
        amount: stake.tokens,
        type: 'refund',
        idempotencyKey: `neglect:${postId}:${stake.userId}`,
        ref: { eventId: event._id ?? event.id, postId },
      });
      refundedTokens += stake.tokens;
      stakerCount += 1;
    } catch (err) {
      // One staker's refund failing must not abandon the rest — the others are owed their
      // tokens regardless. The deterministic key means re-running settles only what is left.
      log.error('Refund failed for one staker — others continue', {
        postId,
        userId: stake.userId,
        tokens: stake.tokens,
        err,
      });
    }
  }

  log.info('Post neglected and refunded', { postId, refundedTokens, stakerCount, reversedCents });
  return { refundedTokens, stakerCount, reversedCents, grossValueCents: value.totalCents };
}

/**
 * A host's earnings totals, for `GET /api/v1/revenue/host/:hostId/summary`.
 *
 * `pendingCents` comes from the wallet (the authoritative spendable number); `booked`, `voided`
 * and `paid` are summed from the entries. Both are returned rather than one derived from the
 * other, because a divergence between them is exactly the bug worth surfacing — and a summary
 * that quietly hides it is a summary nobody can audit.
 *
 * @param {string} hostId - The host.
 * @returns {Promise<{hostId: string, pendingCents: number, bookedCents: number, voidedCents: number, paidCents: number, lifetimeBookedCents: number, entryCount: number}>}
 */
async function getHostSummary(hostId) {
  if (!hostId) throw new AppError(400, 'A host id is required.');

  const [wallet, totals] = await Promise.all([
    repo.getOrCreateWallet(hostId),
    repo.summaryForHost(hostId),
  ]);

  return {
    hostId: String(hostId),
    pendingCents: wallet.pendingCents,
    bookedCents: totals.booked,
    voidedCents: totals.voided,
    paidCents: totals.paid,
    lifetimeBookedCents: wallet.lifetimeBookedCents,
    entryCount: totals.entryCount,
  };
}

/** One host's revenue entries, newest first — the detail behind the summary. */
function getHostEntries(hostId, options) {
  return repo.findEntriesByHost(hostId, options);
}

/** Every refund issued against a post — the "AttendeeRefund records" view over the ledger. */
function getRefundsForPost(postId) {
  return walletRepo.findRefundsForPost(postId);
}

module.exports = {
  valuePost,
  bookHostRevenue,
  reverseHostRevenue,
  getHostSummary,
  getHostEntries,
  getRefundsForPost,
  stakeholdersFor,
};
