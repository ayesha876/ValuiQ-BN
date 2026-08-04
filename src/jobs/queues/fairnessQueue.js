/**
 * fairnessQueue.js — the BullMQ queue that makes auto-neglect PUNCTUAL.
 *
 * One delayed job per post, fired when its neglect deadline passes. Plus one earlier job that
 * warns the control room the clock is nearly up.
 *
 * ── PUNCTUAL, NOT RESPONSIBLE ─────────────────────────────────────────────────────────────
 * This queue is an optimisation, not the guarantee. If Redis is absent, unreachable, or loses
 * every job, attendees are still refunded — the worker's database sweep finds overdue posts
 * from `neglectDeadlineAt` alone (post.repository.findOverdue). That split is deliberate and
 * it is what lets Redis be optional:
 *
 *   Redis      -> refunds happen ON TIME (to the second)
 *   PostgreSQL… sorry, MongoDB -> refunds happen AT ALL (within one sweep interval)
 *
 * Losing the first is a degraded experience. Losing the second would be losing money. Only one
 * of those may depend on infrastructure being up.
 *
 * ── JOB IDS ARE DERIVED, NOT RANDOM ───────────────────────────────────────────────────────
 * `fairness-timer:<postId>` exactly as the brief specifies. BullMQ deduplicates on jobId, so
 * scheduling twice for one post is harmless, and cancelling needs nothing to have been stored
 * anywhere — the id is recomputable from the post alone.
 */
const { Queue } = require('bullmq');
const { getRedis, isRedisEnabled } = require('../../shared/config/redis');
const { createLogger } = require('../../shared/utils/logger');

const log = createLogger('fairness-queue');

/** The queue name, shared by the producer here and the worker. */
const QUEUE_NAME = 'fairness-timer';

/** Job kinds carried on the one queue — fan-out by name is cheaper than a queue each. */
const JOB_NEGLECT = 'neglect';
const JOB_WARN = 'warn';

let queue = null;

/** `fairness-timer:<postId>` — the id the brief specifies, and the cancellation handle. */
function neglectJobId(postId) {
  return `${QUEUE_NAME}:${String(postId)}`;
}

/** The warning fires on its own id so cancelling one does not cancel the other. */
function warnJobId(postId) {
  return `${QUEUE_NAME}:warn:${String(postId)}`;
}

/**
 * The queue, or null when Redis is unconfigured.
 *
 * Lazy: constructing a BullMQ Queue opens a connection, and doing that at import time would
 * make every test that merely requires a service dial Redis.
 *
 * @returns {import('bullmq').Queue|null} The queue, or null when Redis is not configured.
 */
function getFairnessQueue() {
  if (!isRedisEnabled()) return null;
  if (queue) return queue;

  const connection = getRedis();
  if (!connection) return null;

  queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Three attempts with backoff. A failing settlement is usually a transient database
      // problem, and the settlement itself is idempotent, so retrying is safe by construction.
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },

      // Keep completed jobs briefly for observability, failures for much longer — a failed
      // refund is something a person needs to be able to find. This is the DEAD LETTER
      // retention the brief asks for: BullMQ keeps exhausted jobs on the `failed` set, and
      // the worker's `failed` handler is the alerting hook.
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 604_800 }, // seven days
    },
  });

  queue.on('error', (err) => log.warn('Fairness queue error', { err }));
  return queue;
}

/** Release the queue so a test run or restart leaves nothing open. */
async function closeFairnessQueue() {
  if (!queue) return;
  const open = queue;
  queue = null;
  await open.close().catch(() => {});
}

module.exports = {
  QUEUE_NAME,
  JOB_NEGLECT,
  JOB_WARN,
  neglectJobId,
  warnJobId,
  getFairnessQueue,
  closeFairnessQueue,
};
