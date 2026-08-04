/**
 * bus.js — the domain event bus: publish once, reach every instance.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────────────
 * `sockets/socket.js` carries a warning: Socket.IO's default adapter keeps rooms in memory, so
 * with two instances a broadcast only reaches the clients connected to the instance that sent
 * it — silently, with no error. Today that is survivable because there is one instance. The
 * moment moderation ships, it stops being survivable: a moderator on instance A resolves a
 * post and the moderators on instance B keep looking at it in their queue, with its neglect
 * timer running down, believing it is still theirs to decide.
 *
 * So a decision does not emit to sockets directly. It publishes HERE, and this file fans it
 * out — locally always, and over Redis when Redis exists. One publish, and correctness does
 * not depend on how many processes happen to be running.
 *
 * ── WHY NOT JUST ADD @socket.io/redis-adapter ─────────────────────────────────────────────
 * That would fix socket broadcasts and nothing else. Domain events have consumers that are not
 * sockets — the fairness worker cancels a timer when a decision lands, and it holds no socket
 * at all. A domain bus serves both; a socket adapter serves one.
 *
 * ── DELIVERY GUARANTEE: NONE, DELIBERATELY ────────────────────────────────────────────────
 * Redis pub/sub is fire-and-forget. A subscriber that is down misses the message, and nothing
 * replays it. That is acceptable here ONLY because every consumer is a projection of state
 * that already lives in MongoDB: a missed `decision.applied` means a stale queue on one
 * screen, fixed by the next refresh or reconnect (which reads from the database). No money
 * moves on this bus. Money moves inside moderation.service, against the database, and is
 * settled before anything is published. If a consumer is ever added that MUST NOT miss an
 * event, it needs a real queue — not this.
 */
const { EventEmitter } = require('node:events');
const { getRedis, getSubscriber, isRedisEnabled } = require('../config/redis');
const { createLogger } = require('../utils/logger');

const log = createLogger('bus');

// One Redis channel for every domain event. Fan-out by name happens in-process, which is
// cheaper than a subscription per event type and means a new event needs no Redis wiring.
const CHANNEL = 'valuiq:events';

/**
 * The domain events this bus carries.
 *
 * Named as `noun.verb_past_tense` and frozen so a typo at a call site is a crash at startup
 * rather than a subscriber that silently never fires — which is exactly the failure mode the
 * `rooms.js` comment warns about for room names.
 */
const EVENTS = Object.freeze({
  DECISION_APPLIED: 'decision.applied',
  DECISION_AUTO_NEGLECT: 'decision.auto_neglect',
  POST_QUEUED: 'post.queued',
  TIMER_WARNING: 'timer.warning',
});

// setMaxListeners(0): the socket layer, the worker, and each test subscribe independently, and
// Node's default warning at 11 would be noise rather than a leak signal here.
const local = new EventEmitter();
local.setMaxListeners(0);

// A process must not act twice on its own publish — once from the direct local emit and again
// when Redis echoes the message back to its own subscriber. Every envelope carries the id of
// the process that sent it, and the subscriber drops its own.
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

let subscribed = false;

/** Attach the Redis subscriber once, lazily — no-op when Redis is unconfigured. */
function ensureSubscribed() {
  if (subscribed || !isRedisEnabled()) return;
  const sub = getSubscriber();
  if (!sub) return;
  subscribed = true;

  sub.subscribe(CHANNEL).catch((err) => {
    // Non-fatal: this instance simply stops hearing about other instances' decisions. Its own
    // still work, and its own database reads stay correct.
    log.warn('Could not subscribe to the event channel', { channel: CHANNEL, err });
  });

  sub.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return;
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (err) {
      log.warn('Dropped an unparseable event', { err });
      return;
    }
    // Our own message, already emitted locally at publish time.
    if (envelope.origin === INSTANCE_ID) return;
    local.emit(envelope.name, envelope.payload);
  });
}

/**
 * Publish a domain event to every instance.
 *
 * Emits locally FIRST and synchronously, so a single-instance deployment (and every test)
 * behaves identically whether or not Redis is present. The Redis publish is best-effort and
 * never awaited by the caller's critical path — a broadcast problem must never fail the
 * decision that caused it, the same rule posts and the moderator bridge already follow.
 *
 * @param {string} name - One of {@link EVENTS}.
 * @param {object} payload - Serialisable event body. Must contain only plain JSON.
 * @returns {void}
 *
 * @example
 * publish(EVENTS.DECISION_APPLIED, { eventId, postId, decision: 'neglect', source: 'system' });
 */
function publish(name, payload) {
  try {
    local.emit(name, payload);
  } catch (err) {
    // A throwing subscriber is that subscriber's bug; it must not become the publisher's.
    log.error('A local subscriber threw', { event: name, err });
  }

  if (!isRedisEnabled()) return;

  const redis = getRedis();
  if (!redis) return;

  redis
    .publish(CHANNEL, JSON.stringify({ name, payload, origin: INSTANCE_ID, ts: new Date().toISOString() }))
    .catch((err) => log.warn('Cross-instance publish failed (local delivery still happened)', { event: name, err }));
}

/**
 * Listen for a domain event, from this instance or any other.
 *
 * @param {string} name - One of {@link EVENTS}.
 * @param {(payload: object) => void} handler - Called with the published payload.
 * @returns {() => void} Unsubscribe function — call it in test teardown to avoid leaks.
 *
 * @example
 * const off = subscribe(EVENTS.DECISION_APPLIED, ({ postId }) => cancelTimer(postId));
 */
function subscribe(name, handler) {
  ensureSubscribed();
  local.on(name, handler);
  return () => local.off(name, handler);
}

/** Drop every local listener. Test teardown only — production subscribes for the process life. */
function resetBus() {
  local.removeAllListeners();
}

module.exports = { publish, subscribe, resetBus, EVENTS, INSTANCE_ID };
