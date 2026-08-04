/**
 * fairnessTimer.worker.js — the process that keeps the refund promise.
 *
 * Two independent mechanisms, and the redundancy is the design:
 *
 *   1. THE BULLMQ WORKER  — consumes the delayed jobs. Precise to the second. Needs Redis.
 *   2. THE DATABASE SWEEP — every minute, finds posts past `neglectDeadlineAt` that nobody
 *                           settled, and settles them. Needs nothing but MongoDB.
 *
 * Either alone would satisfy the acceptance criterion. Both together mean the promise survives
 * Redis being down, a lost job, a deploy that restarts mid-delay, or a queue that was never
 * configured at all. Attendees are refunded even when the infrastructure that was supposed to
 * remind us has failed — and since the alternative is people silently losing money, that is
 * worth one extra query a minute.
 *
 * ── WHY RUNNING BOTH IS SAFE ──────────────────────────────────────────────────────────────
 * They will absolutely collide: the sweep will pick up posts the worker is already handling,
 * and with several instances every sweep runs everywhere at once. None of that matters,
 * because settlement is claimed through the unique index on `ModerationDecision.post`. The
 * loser is handed the winner's decision and does nothing. There is no distributed lock here
 * because there does not need to be one — the database already provides mutual exclusion, and
 * a Redis lock on top would be a second, weaker guarantee protecting an invariant that is
 * already safe.
 *
 * That is also what makes this HORIZONTALLY SCALABLE: run ten of these and exactly one
 * refund happens per post.
 */
const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const config = require('../../shared/config/env');
const { getRedis, isRedisEnabled } = require('../../shared/config/redis');
const { createLogger } = require('../../shared/utils/logger');
const { QUEUE_NAME, JOB_NEGLECT, JOB_WARN } = require('../queues/fairnessQueue');
const postRepo = require('../../modules/posts/post.repository');
const eventRepo = require('../../modules/events/event.repository');
const moderationService = require('../../modules/moderation/moderation.service');
const { DECIDABLE_STATUSES } = require('../../modules/posts/post.model');
const { publish, EVENTS } = require('../../shared/events/bus');
const { emitToEvent } = require('../../sockets/socket');

const log = createLogger('fairness-worker');

let worker = null;
let sweepTimer = null;

/**
 * Auto-neglect one post: refund everyone who staked on it.
 *
 * ⚠️ THE GUARD IS THE RE-READ, NOT THE JOB. A job firing proves a deadline elapsed; it proves
 * nothing about whether a moderator got there first. So the post's CURRENT state is read here
 * and checked before anything moves. Between the job being queued and it running, a moderator
 * may well have decided — and in a busy event, usually has.
 *
 * Even if this check passed wrongly, `applyDecision` would still refuse: the decision claim is
 * a unique insert. Two layers, because refunding twice cannot be undone.
 *
 * @param {string} postId - The post whose timer expired.
 * @returns {Promise<{settled: boolean, reason?: string, refundedTokens?: number}>}
 */
async function autoNeglect(postId) {
  const post = await postRepo.findById(postId);

  if (!post) return { settled: false, reason: 'post-gone' };

  // A moderator beat the clock. This is the common case, not an error.
  if (!DECIDABLE_STATUSES.includes(post.status)) {
    log.debug('Timer fired for an already-settled post — nothing to do', { postId, status: post.status });
    return { settled: false, reason: 'already-decided' };
  }

  const event = await eventRepo.findActiveById(post.event);
  if (!event) return { settled: false, reason: 'event-gone' };

  const outcome = await moderationService.applyDecision({
    event,
    postId: String(post._id ?? post.id),
    decision: 'neglect',
    // The brief's requirement, and independently worth recording: an event settled mostly by
    // the clock is a host SLA failure, and indistinguishable from a well-moderated one without
    // this field.
    source: 'system',
    reason: 'Fairness timer expired — no moderator decision before the deadline.',
  });

  log.info('Auto-neglected an overdue post', {
    postId,
    eventId: String(post.event),
    refundedTokens: outcome.financials.refundedTokens,
    stakerCount: outcome.financials.stakerCount,
  });

  return { settled: true, refundedTokens: outcome.financials.refundedTokens };
}

/**
 * Warn the control room that a post is close to timing out.
 *
 * Purely advisory — it moves no money and settles nothing. If it is missed, the post is still
 * auto-neglected on schedule; the moderator simply loses the nudge that might have let them
 * answer in time.
 */
async function warnExpiring({ postId, eventId, deadlineAt }) {
  const post = await postRepo.findById(postId);
  if (!post || !DECIDABLE_STATUSES.includes(post.status)) return { warned: false };

  const payload = {
    postId: String(postId),
    eventId: String(eventId),
    deadlineAt,
    secondsRemaining: Math.max(Math.round((new Date(deadlineAt).getTime() - Date.now()) / 1_000), 0),
  };

  publish(EVENTS.TIMER_WARNING, payload);
  emitToEvent(eventId, 'queue:timer_warning', payload);
  return { warned: true };
}

/**
 * THE SAFETY NET. Settle everything already past its deadline.
 *
 * Runs on an interval and once at boot. The boot pass is the important one: it is what
 * recovers a deploy that restarted while jobs were still delayed, and it is why losing Redis
 * entirely costs punctuality rather than money.
 *
 * @param {{now?: Date, limit?: number}} [options] - Clock override and batch size, for tests.
 * @returns {Promise<{examined: number, settled: number}>} What this pass did.
 *
 * @example
 * await sweepOverdue(); // called at boot and every FAIRNESS_SWEEP_INTERVAL_SECONDS
 */
async function sweepOverdue({ now = new Date(), limit = 200 } = {}) {
  // Nothing to sweep against if the database is not up yet — a worker started before the
  // connection resolved must not throw on its first tick.
  if (mongoose.connection.readyState !== 1) return { examined: 0, settled: 0 };

  const overdue = await postRepo.findOverdue({ now, limit });
  if (!overdue.length) return { examined: 0, settled: 0 };

  let settled = 0;
  for (const post of overdue) {
    try {
      // Sequential on purpose. These are money writes, and a burst of concurrent settlements
      // across dozens of posts buys nothing while making a partial failure far harder to read.
      const result = await autoNeglect(String(post._id));
      if (result.settled) settled += 1;
    } catch (err) {
      // A 409 means somebody else already owns this post's decision — another sweep, another
      // instance, or a moderator who acted a moment ago. That is the exclusion mechanism
      // working exactly as designed, not a failure, and logging it at error level would train
      // people to ignore a channel that must stay trustworthy.
      if (err.statusCode === 409) {
        log.debug('Another actor is settling this post — skipping', { postId: String(post._id) });
        continue;
      }

      // Anything else IS a problem, and one post failing must not abandon the rest: every
      // other overdue attendee is still owed their tokens. The next sweep retries this one.
      log.error('Sweep could not settle a post — continuing with the rest', { postId: String(post._id), err });
    }
  }

  if (settled) log.info('Fairness sweep settled overdue posts', { examined: overdue.length, settled });
  return { examined: overdue.length, settled };
}

/**
 * Start the BullMQ worker, if Redis is configured.
 *
 * @returns {import('bullmq').Worker|null} The worker, or null when Redis is unconfigured.
 */
function startWorker() {
  if (!isRedisEnabled()) {
    log.warn('Redis not configured — fairness timers will run on the database sweep alone');
    return null;
  }
  if (worker) return worker;

  const connection = getRedis();
  if (!connection) return null;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === JOB_WARN) return warnExpiring(job.data);
      if (job.name === JOB_NEGLECT) return autoNeglect(job.data.postId);
      // An unknown job name is a deploy skew, not a data problem — log and drop rather than
      // retrying something this version does not understand.
      log.warn('Ignoring an unrecognised job', { name: job.name, jobId: job.id });
      return { settled: false, reason: 'unknown-job' };
    },
    {
      connection,
      // Modest: each job is a short burst of database writes, and the sweep is the backstop
      // for throughput anyway. Raising this trades tail latency for database contention.
      concurrency: Number(process.env.FAIRNESS_WORKER_CONCURRENCY) || 5,
    },
  );

  /**
   * ── THE DEAD LETTER / ALERTING HOOK ────────────────────────────────────────────────────
   * BullMQ moves a job to the `failed` set once its attempts are exhausted; `removeOnFail`
   * keeps it there for a week (see fairnessQueue.js). This handler is where that becomes
   * visible. A `level: error` line with `attemptsMade` at the limit is the signal to alert on
   * — an attendee is owed tokens they have not received.
   *
   * Deliberately NOT wired to an email or a pager here: this codebase has no alerting
   * transport, and inventing one inside a worker is how a half-configured pager gets shipped.
   * The structured line is the integration point; point a log-based alert at it.
   */
  worker.on('failed', (job, err) => {
    const exhausted = job && job.attemptsMade >= (job.opts?.attempts ?? 1);
    log.error(exhausted ? 'DEAD LETTER — fairness job exhausted its retries' : 'Fairness job attempt failed', {
      jobId: job?.id,
      name: job?.name,
      postId: job?.data?.postId,
      attemptsMade: job?.attemptsMade,
      deadLettered: Boolean(exhausted),
      err,
    });
  });

  worker.on('error', (err) => log.warn('Fairness worker error', { err }));

  log.info('Fairness worker started', { queue: QUEUE_NAME });
  return worker;
}

/**
 * Start the periodic database sweep.
 *
 * `unref()` so a lingering interval can never hold the process open — a test run or a
 * graceful shutdown must not wait on the next tick.
 *
 * @returns {NodeJS.Timeout|null} The interval handle.
 */
function startSweep() {
  if (sweepTimer) return sweepTimer;

  const intervalMs = config.fairness.sweepIntervalSeconds * 1_000;

  // Catch up immediately on boot — this is what recovers a restart that happened while jobs
  // were still delayed.
  sweepOverdue().catch((err) => log.error('Boot sweep failed', { err }));

  sweepTimer = setInterval(() => {
    sweepOverdue().catch((err) => log.error('Fairness sweep failed', { err }));
  }, intervalMs);

  sweepTimer.unref();
  log.info('Fairness sweep started', { intervalSeconds: config.fairness.sweepIntervalSeconds });
  return sweepTimer;
}

/**
 * Start both halves of the fairness mechanism.
 *
 * @returns {{worker: import('bullmq').Worker|null, sweep: NodeJS.Timeout|null}}
 */
function startFairnessTimer() {
  return { worker: startWorker(), sweep: startSweep() };
}

/** Stop everything so a test run or restart leaves nothing running. */
async function stopFairnessTimer() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (worker) {
    const open = worker;
    worker = null;
    await open.close().catch(() => {});
  }
}

module.exports = {
  startFairnessTimer,
  stopFairnessTimer,
  sweepOverdue,
  autoNeglect,
  warnExpiring,
};
