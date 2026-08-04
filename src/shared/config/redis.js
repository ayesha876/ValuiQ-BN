/**
 * redis.js — the ONE place that opens a Redis connection.
 *
 * Redis arrives with Week 4 for two jobs: BullMQ's fairness timers, and pub/sub so a decision
 * taken on one instance still reaches sockets held by another.
 *
 * ── REDIS IS OPTIONAL, AND THAT IS THE IMPORTANT PART ─────────────────────────────────────
 * `REDIS_URL` unset means every function here returns null and the app runs exactly as it did
 * before. That is not laziness about configuration — it is the difference between a dependency
 * and a hard requirement:
 *
 *   - The existing test suite (7 files, no Redis) must keep passing untouched. A module that
 *     dialled Redis at import time would break every one of them on load.
 *   - `npm run dev` on a laptop with no Redis installed must still boot. The moment local
 *     development needs infrastructure, people stop running it locally.
 *   - Losing Redis in production must degrade the fairness timer, not take down posting,
 *     voting, or the moderator's ability to decide by hand.
 *
 * The cost is that auto-neglect stops firing on time without Redis. That is covered: the
 * worker also runs a database sweep (see fairnessTimer.worker.js) which finds overdue posts
 * from `createdAt + neglectTimer` alone. Redis makes neglect PUNCTUAL; the database makes it
 * INEVITABLE. Losing the punctual half is a degradation, not a hole in the money.
 */
const IORedis = require('ioredis');
const config = require('./env');
const { createLogger } = require('../utils/logger');

const log = createLogger('redis');

// Two separate connections, created lazily. A Redis client in subscriber mode may only issue
// subscribe commands — it cannot publish, and it cannot serve BullMQ. Sharing one would work
// until the first publish, then fail at runtime with an error that reads like a bug in the
// caller rather than a misuse of the protocol.
let shared = null;
let subscriber = null;

/** True when Redis is configured. Callers branch on this rather than catching connect errors. */
function isRedisEnabled() {
  return Boolean(config.redisUrl);
}

function build(role) {
  const client = new IORedis(config.redisUrl, {
    // REQUIRED BY BULLMQ. Its blocking commands (BRPOPLPUSH) legitimately sit open for
    // minutes; ioredis's default retry cap treats that as a stalled request and kills the
    // connection mid-wait. `null` disables the cap, which is what BullMQ documents.
    maxRetriesPerRequest: null,

    // Queue commands while reconnecting instead of failing them. A blip should delay a timer,
    // not lose it.
    enableOfflineQueue: true,

    // Exponential-ish backoff with a ceiling, so a long outage does not become a reconnect
    // storm against a Redis that is already struggling.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  // An unhandled 'error' event on an ioredis client is an unhandled EventEmitter error, which
  // takes the process down. Logging it keeps a Redis outage survivable.
  client.on('error', (err) => log.warn('Redis connection error', { role, err }));
  client.on('ready', () => log.info('Redis connected', { role }));

  return client;
}

/**
 * The general-purpose client: BullMQ, publishing, and any future key/value use.
 *
 * @returns {import('ioredis').Redis|null} The client, or null when `REDIS_URL` is unset.
 */
function getRedis() {
  if (!isRedisEnabled()) return null;
  if (!shared) shared = build('shared');
  return shared;
}

/**
 * A dedicated subscriber connection.
 *
 * Separate from {@link getRedis} because Redis puts a subscribed connection into a mode where
 * only (un)subscribe commands are legal. This one only ever listens.
 *
 * @returns {import('ioredis').Redis|null} The subscriber, or null when Redis is unconfigured.
 */
function getSubscriber() {
  if (!isRedisEnabled()) return null;
  if (!subscriber) subscriber = build('subscriber');
  return subscriber;
}

/**
 * Close every connection so a test run or a restart leaves nothing open.
 *
 * `quit` rather than `disconnect`: it lets in-flight commands finish, so a publish issued a
 * millisecond before shutdown is not silently dropped.
 *
 * @returns {Promise<void>} Resolves once both connections are closed.
 */
async function closeRedis() {
  const open = [shared, subscriber].filter(Boolean);
  shared = null;
  subscriber = null;
  await Promise.allSettled(open.map((client) => client.quit()));
}

module.exports = { getRedis, getSubscriber, isRedisEnabled, closeRedis };
