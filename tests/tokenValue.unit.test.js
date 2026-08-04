/**
 * tokenValue.unit.test.js — the arithmetic that turns tokens into a host's real money.
 *
 * Pure functions, no database, no mocks. These are the numbers a host will one day dispute, so
 * the cases below are written as a table someone can check on paper.
 *
 * The property that matters most and is asserted repeatedly: ROUNDING NEVER CREATES MONEY.
 * Every conversion floors, so the total booked can never exceed the total actually paid.
 */
import { describe, it, expect } from 'vitest';

const {
  centsPerToken,
  stakeValueCents,
  hostShareCents,
  valuePostStakes,
} = (await import('../src/shared/utils/tokenValueCalculator.js')).default;

describe('centsPerToken', () => {
  it('averages what an attendee actually paid across their purchases', () => {
    // Arrange — 100 tokens bought for $25.00
    const totals = { purchasedTokens: 100, purchasedCents: 2500 };

    // Act
    const rate = centsPerToken(totals);

    // Assert
    expect(rate).toBe(25);
  });

  it('blends packages bought at different rates', () => {
    // 100 @ 25c plus 500 @ 20c = 600 tokens for 12500c => 20.83…c per token.
    // Deliberately NOT rounded here: this is an intermediate, and rounding it before
    // multiplying by a stake would compound the error by the size of the stake.
    const rate = centsPerToken({ purchasedTokens: 600, purchasedCents: 12_500 });

    expect(rate).toBeCloseTo(20.8333, 3);
  });

  it('returns 0 for an attendee who has only ever been granted tokens', () => {
    // Every attendee today, until Stripe lands in Week 5. Nobody paid, so the host earns
    // nothing real — inventing a default rate here would fabricate revenue from a dev grant.
    expect(centsPerToken({ purchasedTokens: 0, purchasedCents: 0 })).toBe(0);
  });

  it('returns 0 rather than dividing by zero on malformed totals', () => {
    expect(centsPerToken({ purchasedTokens: 0, purchasedCents: 5000 })).toBe(0);
    expect(centsPerToken(undefined)).toBe(0);
    expect(centsPerToken({})).toBe(0);
  });
});

describe('stakeValueCents', () => {
  it('values a stake at its owner’s rate', () => {
    expect(stakeValueCents(120, 25)).toBe(3000);
  });

  it('floors a fractional cent rather than rounding it up', () => {
    // 7 × 25.5 = 178.5. Rounding to nearest would book 179c — half a cent nobody paid.
    expect(stakeValueCents(7, 25.5)).toBe(178);
  });

  it('is zero for a zero rate, so granted-only stakes are worth nothing real', () => {
    expect(stakeValueCents(5_000, 0)).toBe(0);
  });

  it('refuses negative or nonsense inputs instead of producing negative money', () => {
    expect(stakeValueCents(-10, 25)).toBe(0);
    expect(stakeValueCents(10, -25)).toBe(0);
    expect(stakeValueCents(Number.NaN, 25)).toBe(0);
  });
});

describe('hostShareCents — the three moderation outcomes', () => {
  // ValuiQ_Client_Overview §9 / QinMvpDocs §6, on a post worth $30.00.
  const GROSS = 3000;

  it('Address gives the host the full value', () => {
    expect(hostShareCents(GROSS, 100, 100)).toBe(3000);
  });

  it('Dismiss gives the host half', () => {
    expect(hostShareCents(GROSS, 100, 50)).toBe(1500);
  });

  it('Neglect gives the host nothing', () => {
    expect(hostShareCents(GROSS, 100, 0)).toBe(0);
  });

  it('applies a per-event revenue share on top of the decision multiplier', () => {
    // An 80/20 deal, dismissed: 3000 × 0.8 × 0.5 = 1200.
    expect(hostShareCents(GROSS, 80, 50)).toBe(1200);
  });

  it('floors ONCE over the combined fraction, not twice', () => {
    // 999 × 0.8 × 0.5 = 399.6 -> 399.
    // Flooring in two steps would give floor(999×0.8)=799, then floor(799×0.5)=399 here, but
    // the single-floor form is what guarantees the loss is at most one cent for ANY inputs.
    expect(hostShareCents(999, 80, 50)).toBe(399);
  });

  it('never exceeds the gross value, whatever it is handed', () => {
    // Out-of-range percentages are clamped rather than trusted — a config typo must not be
    // able to pay a host more than the audience spent.
    expect(hostShareCents(GROSS, 500, 500)).toBe(3000);
    expect(hostShareCents(GROSS, -10, 100)).toBe(0);
  });
});

describe('valuePostStakes — a post is valued staker by staker', () => {
  it('sums each staker at their OWN rate, never at a post-level average', () => {
    // Arrange — two people stake identically but bought in at very different prices.
    const stakes = [
      { userId: 'alice', tokens: 100 },
      { userId: 'bob', tokens: 100 },
    ];
    const rates = new Map([
      ['alice', 25], // paid 25c/token
      ['bob', 10], // caught a bulk deal
    ]);

    // Act
    const result = valuePostStakes(stakes, rates);

    // Assert — 2500 + 1000. A post-level average would have said 3500/2 each and been wrong
    // about both of them.
    expect(result.totalTokens).toBe(200);
    expect(result.totalCents).toBe(3500);
    expect(result.perStaker).toEqual([
      { userId: 'alice', tokens: 100, cents: 2500 },
      { userId: 'bob', tokens: 100, cents: 1000 },
    ]);
  });

  it('treats a staker with no known rate as worth nothing real, not as an error', () => {
    const result = valuePostStakes([{ userId: 'ghost', tokens: 500 }], new Map());

    expect(result.totalTokens).toBe(500); // still owed their tokens back on a neglect
    expect(result.totalCents).toBe(0); // but the host earns no real money from them
  });

  it('ignores zero and negative stakes', () => {
    const result = valuePostStakes(
      [
        { userId: 'a', tokens: 0 },
        { userId: 'b', tokens: -5 },
        { userId: 'c', tokens: 10 },
      ],
      new Map([['c', 10]]),
    );

    expect(result.perStaker).toHaveLength(1);
    expect(result.totalCents).toBe(100);
  });

  it('returns a zeroed result for a post nobody staked on', () => {
    expect(valuePostStakes([], new Map())).toEqual({ totalTokens: 0, totalCents: 0, perStaker: [] });
  });
});
