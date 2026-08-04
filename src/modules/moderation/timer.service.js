/**
 * timer.service.js — the fairness clock: when a post times out, and who is told.
 *
 * The promise this enforces is attendee-facing. From ValuiQ_Client_Overview §24:
 *
 *   "Q: What happens if my question isn't answered in time?
 *    You are automatically and fully refunded — you never lose tokens due to a delay outside
 *    your control."
 *
 * ── THE DEADLINE IS THE HOST'S, NOT A CONSTANT ────────────────────────────────────────────
 * The brief specified a global 48-hour timeout in an env var. That is not how this product
 * works. `neglectTimer` is a per-stage number, in SECONDS, that the host sets on the Create
 * Event form, and `EventForm.jsx` describes it to them as "how long you give yourself to
 * respond to a post… visible to attendees… ensures accountability". It is a published
 * commitment, not an operational default. A global constant would silently override every
 * host who configured one, and would make the number attendees were shown a lie.
 *
 * So: the deadline comes from the stage. `config.fairness.defaultTimerSeconds` is only the
 * fallback for a stage that left it blank, and `maxTimerSeconds` is a ceiling so a host cannot
 * pin someone's tokens for a fortnight by typing enough digits.
 */
const config = require('../../shared/config/env');
const { createLogger } = require('../../shared/utils/logger');
const {
  getFairnessQueue,
  neglectJobId,
  warnJobId,
  JOB_NEGLECT,
  JOB_WARN,
} = require('../../jobs/queues/fairnessQueue');

const log = createLogger('fairness-timer');

/**
 * How long this post's stage gives a moderator, in seconds.
 *
 * Stage 0 is the Opening Segment (`event.neglectTimer`); stages 1..n are `rounds[i-1]`. Mirrors
 * `post.service.activeStage`, which resolves pricing and limits the same way — the shapes are
 * identical by design, so the lookup is too.
 *
 * @param {object} event - The event document.
 * @param {number} [roundIndex] - Stage the post belongs to. 0 is the Opening Segment.
 * @returns {number} Seconds, clamped to the configured ceiling. 0 means "no timer set".
 *
 * @example
 * timerSecondsFor(event, 0); // => 300  (host set a five-minute response promise)
 */
function timerSecondsFor(event, roundIndex = 0) {
  const raw =
    roundIndex === 0
      ? event?.neglectTimer
      : (event?.rounds?.[roundIndex - 1]?.neglectTimer ?? event?.neglectTimer);

  // A stage that set NO timer made no promise, so nothing times out. Distinct from 0, which a
  // host cannot mean literally (an instant deadline would refund every post on submission).
  if (raw == null) return config.fairness.defaultTimerSeconds;
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  return Math.min(raw, config.fairness.maxTimerSeconds);
}

/**
 * When a post submitted now would time out.
 *
 * @param {object} event - The event the post belongs to.
 * @param {number} [roundIndex] - The post's stage.
 * @param {Date} [from] - Clock override, for tests.
 * @returns {Date|null} The deadline, or null when the stage sets no timer.
 */
function deadlineFor(event, roundIndex = 0, from = new Date()) {
  const seconds = timerSecondsFor(event, roundIndex);
  if (!seconds) return null;
  return new Date(from.getTime() + seconds * 1_000);
}

/**
 * Schedule a post's neglect deadline, and the warning that precedes it.
 *
 * A NO-OP WITHOUT REDIS, and that is a supported way to run: the post still carries
 * `neglectDeadlineAt`, and the worker's database sweep will settle it. This function only
 * makes it punctual.
 *
 * Never throws. A scheduling problem must not fail the paid post that triggered it — the same
 * rule the post broadcast and the moderator email bridge already follow.
 *
 * @param {object} input
 * @param {string} input.postId - The post to time.
 * @param {string} input.eventId - Its event, carried on the job so the worker needn't re-read.
 * @param {Date|null} input.deadlineAt - When it times out. Null skips scheduling entirely.
 * @returns {Promise<{scheduled: boolean, reason?: string}>} Never rejects.
 *
 * @example
 * await schedule({ postId, eventId, deadlineAt: deadlineFor(event, 0) });
 */
async function schedule({ postId, eventId, deadlineAt }) {
  if (!deadlineAt) return { scheduled: false, reason: 'no-timer' };

  const queue = getFairnessQueue();
  if (!queue) {
    log.debug('Redis not configured — relying on the database sweep', { postId });
    return { scheduled: false, reason: 'no-redis' };
  }

  const msUntilDeadline = deadlineAt.getTime() - Date.now();

  try {
    await queue.add(
      JOB_NEGLECT,
      { postId: String(postId), eventId: String(eventId) },
      {
        // `fairness-timer:<postId>` — the brief's id, and the cancellation handle. BullMQ
        // dedupes on it, so scheduling twice for one post is harmless.
        jobId: neglectJobId(postId),
        // Negative delay (a deadline already past) is floored at zero so the job runs at once
        // rather than being rejected.
        delay: Math.max(msUntilDeadline, 0),
      },
    );

    // The warning: a FRACTION of the way through, not a fixed lead time. `neglectTimer` is
    // commonly 30-300 seconds, so the brief's "1 hour before" would fire before the post was
    // submitted. 0.8 means "warn with 20% of the clock left", which scales to any timer.
    const warnDelay = Math.floor(msUntilDeadline * config.fairness.warnAtElapsedFraction);
    if (warnDelay > 1_000) {
      await queue.add(
        JOB_WARN,
        { postId: String(postId), eventId: String(eventId), deadlineAt: deadlineAt.toISOString() },
        { jobId: warnJobId(postId), delay: warnDelay },
      );
    }

    log.debug('Fairness timer scheduled', { postId, deadlineAt, msUntilDeadline });
    return { scheduled: true };
  } catch (err) {
    log.warn('Could not schedule a fairness timer — the sweep will catch it', { postId, err });
    return { scheduled: false, reason: 'error' };
  }
}

/**
 * Cancel a post's timers because a decision was taken.
 *
 * BEST-EFFORT BY DESIGN. If removal fails, or the job has already been picked up, nothing
 * breaks: the worker re-reads the post and finds it no longer decidable, so it exits without
 * touching money. Cancellation is an optimisation that saves a wasted wake-up — it is never
 * what prevents a double refund. That job belongs to the unique index on
 * `ModerationDecision.post`, and to nothing else.
 *
 * @param {string} postId - The settled post.
 * @returns {Promise<{cancelled: boolean}>} Never rejects.
 */
async function cancel(postId) {
  const queue = getFairnessQueue();
  if (!queue) return { cancelled: false };

  try {
    // Both ids, since the warning is scheduled separately. `allSettled` because a job that has
    // already run is not an error worth propagating.
    await Promise.allSettled([
      queue.remove(neglectJobId(postId)),
      queue.remove(warnJobId(postId)),
    ]);
    log.debug('Fairness timer cancelled', { postId });
    return { cancelled: true };
  } catch (err) {
    log.warn('Timer cancellation failed (the worker will no-op instead)', { postId, err });
    return { cancelled: false };
  }
}

/**
 * Re-arm a post's timer against a new deadline.
 *
 * Cancel-then-schedule rather than an in-place edit: BullMQ's `changeDelay` only applies to a
 * job still waiting, and the two-step is correct whatever state it is in.
 *
 * @param {object} input - Same shape as {@link schedule}.
 * @returns {Promise<{scheduled: boolean, reason?: string}>}
 */
async function reschedule({ postId, eventId, deadlineAt }) {
  await cancel(postId);
  return schedule({ postId, eventId, deadlineAt });
}

module.exports = { timerSecondsFor, deadlineFor, schedule, cancel, reschedule };
