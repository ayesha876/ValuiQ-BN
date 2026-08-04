/**
 * tokenValueCalculator.js — what a token is WORTH IN REAL MONEY, per attendee.
 *
 * This is the hinge of the whole revenue model, and it is not a constant. From QinMvpDocs §6:
 *
 *   "A token's money-value isn't a fixed guess — it's based on what that particular attendee
 *    actually paid on average across their token purchases. So the host earns in proportion to
 *    what the audience genuinely spent."
 *
 * So two attendees can stake 100 tokens on the same post and the host earns a different amount
 * from each, because they bought at different package rates. That is deliberate: a host must
 * not be able to earn more real money than the audience actually handed over.
 *
 * ── PURE ON PURPOSE ───────────────────────────────────────────────────────────────────────
 * Nothing here touches the database. The ledger read lives in wallet.repository (the only file
 * allowed to), and the arithmetic lives here where it can be unit-tested against a table of
 * numbers instead of a fixture database. When a host disputes an earnings figure, the answer
 * has to be reproducible on paper — which means the maths cannot be tangled up in a query.
 *
 * ── ROUNDING: ALWAYS DOWN, NEVER UP ───────────────────────────────────────────────────────
 * Every conversion floors. Rounding to nearest would, across thousands of posts, credit hosts
 * money no attendee ever paid — inventing currency a cent at a time. The floored remainder is
 * simply not booked; it is not revenue, so it does not need a home. The one rule that must
 * hold: the sum of everything booked can never exceed the sum of everything paid.
 */

/**
 * What one token cost this attendee, in cents, as a full-precision rate.
 *
 * NOT rounded — this is an intermediate. Rounding a per-token rate before multiplying by a
 * stake would compound the error by the size of the stake, which for a 5,000-token stake is
 * real money rather than a rounding artefact. Callers round once, at the end.
 *
 * Granted tokens are excluded from BOTH sides by the caller's query: they were never paid for,
 * so including them would drag the average down toward zero and understate what the audience
 * actually spent. An attendee with no purchases at all has no rate — see the zero case below.
 *
 * @param {{purchasedTokens: number, purchasedCents: number}} totals - Lifetime purchase totals
 *   for one attendee, summed from `type: 'purchase'` ledger entries.
 * @returns {number} Cents per token. `0` when the attendee has never bought tokens.
 *
 * @example
 * centsPerToken({ purchasedTokens: 100, purchasedCents: 2500 }); // => 25
 * centsPerToken({ purchasedTokens: 0, purchasedCents: 0 });      // => 0 (granted-only account)
 */
function centsPerToken({ purchasedTokens = 0, purchasedCents = 0 } = {}) {
  // A granted-only attendee (every attendee today, until Stripe lands in Week 5) has no basis
  // in real money. Zero is the honest answer: the host earns nothing real from tokens nobody
  // bought. Returning a made-up default here would fabricate revenue out of a dev grant.
  if (!purchasedTokens || purchasedTokens <= 0) return 0;
  if (!purchasedCents || purchasedCents <= 0) return 0;

  return purchasedCents / purchasedTokens;
}

/**
 * What a stake of `tokens` is worth in real money, for an attendee on `rate`.
 *
 * @param {number} tokens - Tokens staked (whole).
 * @param {number} rate - Cents per token, from {@link centsPerToken}.
 * @returns {number} Integer cents, floored.
 *
 * @example
 * stakeValueCents(120, 25); // => 3000
 * stakeValueCents(7, 25.5); // => 178  (178.5 floored — the half-cent is never booked)
 */
function stakeValueCents(tokens, rate) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.floor(tokens * rate);
}

/**
 * The host's cut of a post's realised value.
 *
 * `sharePct` is the event's `revenueSharePct` (platform commercial term, server-managed).
 * `decisionPct` is the moderation outcome's multiplier — 100 for Address, 50 for Dismiss,
 * 0 for Neglect (QinMvpDocs §6 / ValuiQ_Client_Overview §9).
 *
 * Applied as ONE floor over the combined fraction rather than flooring twice. Flooring the
 * decision cut and then the platform cut loses up to two cents per post instead of one, and
 * the loss compounds silently across an event.
 *
 * @param {number} valueCents - Full realised value of the stake, in cents.
 * @param {number} sharePct - Host's configured share of the event, 0-100.
 * @param {number} decisionPct - The decision's multiplier, 0-100.
 * @returns {number} Integer cents the host earns, floored.
 *
 * @example
 * hostShareCents(3000, 100, 100); // => 3000  (Address, host keeps everything)
 * hostShareCents(3000, 100, 50);  // => 1500  (Dismiss, half)
 * hostShareCents(3000, 80, 50);   // => 1200  (Dismiss on an 80% revenue-share event)
 * hostShareCents(3000, 100, 0);   // => 0     (Neglect, host earns nothing)
 */
function hostShareCents(valueCents, sharePct, decisionPct) {
  if (!Number.isFinite(valueCents) || valueCents <= 0) return 0;

  const share = Number.isFinite(sharePct) ? Math.min(Math.max(sharePct, 0), 100) : 0;
  const decision = Number.isFinite(decisionPct) ? Math.min(Math.max(decisionPct, 0), 100) : 0;
  if (share === 0 || decision === 0) return 0;

  return Math.floor((valueCents * share * decision) / 10_000);
}

/**
 * Value a whole post: every stake on it, each converted at its own owner's rate.
 *
 * A post's money is not one attendee's money. `tokens` on the post is the author's opening
 * stake plus every backer's since, and each of those people bought in at their own price — so
 * the post is valued stake by stake and summed, never as `post.tokens × one rate`.
 *
 * @param {Array<{userId: string, tokens: number}>} stakes - Every stake on the post.
 * @param {Map<string, number>} ratesByUser - userId -> cents per token.
 * @returns {{totalTokens: number, totalCents: number, perStaker: Array<{userId: string, tokens: number, cents: number}>}}
 *   Totals plus the per-staker breakdown, which is what refund rows are built from.
 *
 * @example
 * valuePostStakes(
 *   [{ userId: 'a', tokens: 100 }, { userId: 'b', tokens: 50 }],
 *   new Map([['a', 25], ['b', 10]]),
 * );
 * // => { totalTokens: 150, totalCents: 3000, perStaker: [...] }
 */
function valuePostStakes(stakes = [], ratesByUser = new Map()) {
  const perStaker = stakes
    .filter((stake) => stake && Number.isFinite(stake.tokens) && stake.tokens > 0)
    .map((stake) => {
      const key = String(stake.userId);
      return {
        userId: key,
        tokens: stake.tokens,
        cents: stakeValueCents(stake.tokens, ratesByUser.get(key) ?? 0),
      };
    });

  return {
    totalTokens: perStaker.reduce((sum, s) => sum + s.tokens, 0),
    totalCents: perStaker.reduce((sum, s) => sum + s.cents, 0),
    perStaker,
  };
}

module.exports = { centsPerToken, stakeValueCents, hostShareCents, valuePostStakes };
