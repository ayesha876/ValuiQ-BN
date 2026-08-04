/**
 * moderation.unit.test.js — the pure decision logic: deadlines and queue urgency.
 *
 * ── WHY THERE ARE NO MOCKED-REPOSITORY TESTS HERE ─────────────────────────────────────────
 * The Week 4 brief asked for service unit tests against mock repositories. That was attempted
 * and removed, because it could not be made trustworthy in this codebase:
 *
 * The app is CommonJS. A test that does `(await import('…/post.repository.js')).default` gets
 * Vitest's INTEROP COPY of `module.exports`, not the live object the service closed over via
 * `require`. `vi.spyOn` on that copy binds to nothing the service will ever call, and
 * `vi.mock` factories do not intercept `require` specifiers here either. Both fail SILENTLY —
 * the stub is simply never used, the real repository runs, and the test passes or fails for
 * reasons unrelated to what it claims to check.
 *
 * A test that lies about money is worse than no test. So the decision path is proven in
 * `moderation.int.test.js` against a real in-memory MongoDB, which is what this repo already
 * does for posts, votes, wallet and sockets — six of its seven existing test files. Only
 * genuinely pure functions are unit-tested, here and in `tokenValue.unit.test.js`.
 */
import { describe, it, expect } from 'vitest';

const timerService = (await import('../src/modules/moderation/timer.service.js')).default;
const queueService = (await import('../src/modules/queue/queue.service.js')).default;
const config = (await import('../src/shared/config/env.js')).default;

describe('timerSecondsFor — the deadline is the host’s, not a constant', () => {
  it('uses the Opening Segment’s neglectTimer for stage 0', () => {
    expect(timerService.timerSecondsFor({ neglectTimer: 120 }, 0)).toBe(120);
  });

  it('uses the round’s own neglectTimer for stages 1..n', () => {
    // Each round carries its own timer — a later round can give moderators longer.
    const event = { neglectTimer: 60, rounds: [{ neglectTimer: 300 }, { neglectTimer: 600 }] };

    expect(timerService.timerSecondsFor(event, 1)).toBe(300);
    expect(timerService.timerSecondsFor(event, 2)).toBe(600);
  });

  it('falls back to the Opening Segment when a round left its timer blank', () => {
    const event = { neglectTimer: 90, rounds: [{}] };

    expect(timerService.timerSecondsFor(event, 1)).toBe(90);
  });

  it('falls back to the configured default when no timer is set anywhere', () => {
    expect(timerService.timerSecondsFor({}, 0)).toBe(config.fairness.defaultTimerSeconds);
  });

  it('caps a host who typed too many digits', () => {
    // Nobody may pin an attendee's tokens for eleven days by mistyping a number.
    expect(timerService.timerSecondsFor({ neglectTimer: 999_999_999 }, 0)).toBe(config.fairness.maxTimerSeconds);
  });

  it('treats an explicit 0 or a negative as "no timer", so nothing is refunded on submission', () => {
    expect(timerService.timerSecondsFor({ neglectTimer: 0 }, 0)).toBe(0);
    expect(timerService.timerSecondsFor({ neglectTimer: -5 }, 0)).toBe(0);
  });
});

describe('deadlineFor', () => {
  it('adds the stage’s timer to the submission moment', () => {
    const from = new Date('2026-08-01T12:00:00.000Z');

    const deadline = timerService.deadlineFor({ neglectTimer: 300 }, 0, from);

    expect(deadline.toISOString()).toBe('2026-08-01T12:05:00.000Z');
  });

  it('returns null when the stage made no promise', () => {
    expect(timerService.deadlineFor({ neglectTimer: 0 }, 0)).toBeNull();
  });
});

describe('severityFor — urgency, derived because this product has no "severity" field', () => {
  const now = new Date('2026-08-01T12:00:00.000Z').getTime();
  const inSeconds = (s) => new Date(now + s * 1000);

  it('is critical inside the last minute', () => {
    const result = queueService.severityFor({ neglectDeadlineAt: inSeconds(30), tokens: 100 }, now);

    expect(result.severity).toBe('critical');
    expect(result.secondsRemaining).toBe(30);
    expect(result.expired).toBe(false);
  });

  it('is critical once the deadline has passed — the sweep is about to refund it', () => {
    const result = queueService.severityFor({ neglectDeadlineAt: inSeconds(-10), tokens: 100 }, now);

    expect(result.severity).toBe('critical');
    expect(result.expired).toBe(true);
    expect(result.secondsRemaining).toBe(0);
  });

  it('escalates a heavily-staked post above a lightly-staked one on the same clock', () => {
    // The whole reason severity is two-dimensional: time alone would rank these equally, and a
    // moderator would let the expensive one expire.
    const light = queueService.severityFor({ neglectDeadlineAt: inSeconds(200), tokens: 50 }, now);
    const heavy = queueService.severityFor({ neglectDeadlineAt: inSeconds(200), tokens: 5000 }, now);

    expect(light.severity).toBe('high');
    expect(heavy.severity).toBe('critical');
  });

  it('is normal when there is plenty of time and little at stake', () => {
    expect(queueService.severityFor({ neglectDeadlineAt: inSeconds(3600), tokens: 50 }, now).severity).toBe('normal');
  });

  it('is low — never urgent — for a post that can never time out', () => {
    const result = queueService.severityFor({ neglectDeadlineAt: null, tokens: 9999 }, now);

    expect(result.severity).toBe('low');
    expect(result.secondsRemaining).toBeNull();
  });
});

describe('shapeRow — the contract the control room and the REST queue share', () => {
  const now = Date.now();

  const post = {
    _id: '507f1f77bcf86cd799439012',
    text: 'Why did the team pivot in 2025?',
    authorName: 'Sarah Chen',
    status: 'live',
    roundIndex: 0,
    tokens: 400,
    createdAt: new Date('2026-08-01T11:00:00.000Z'),
    neglectDeadlineAt: new Date(now + 30_000),
  };

  it('exposes financial exposure in BOTH currencies, never collapsed into one', () => {
    // Tokens go back to attendees; cents are what the host forfeits. Different money, owed to
    // different people — one number would hide which.
    const row = queueService.shapeRow(post, { totalCents: 4000, perStaker: [{}, {}] }, now);

    expect(row.financialExposure).toEqual({ tokensAtRisk: 400, stakerCount: 2, hostForfeitCents: 4000 });
  });

  it('truncates a long post for the list but keeps the full text alongside', () => {
    const long = { ...post, text: 'x'.repeat(200) };

    const row = queueService.shapeRow(long, { totalCents: 0, perStaker: [] }, now);

    expect(row.title).toHaveLength(118); // 117 + the ellipsis
    expect(row.title.endsWith('…')).toBe(true);
    expect(row.text).toHaveLength(200);
  });

  it('emits UTC ISO 8601 timestamps, matching the rest of the API', () => {
    const row = queueService.shapeRow(post, { totalCents: 0, perStaker: [] }, now);

    expect(row.flaggedAt).toBe('2026-08-01T11:00:00.000Z');
    expect(row.deadlineAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});
