/**
 * feedBroadcaster.js — collects feed changes and emits them as ONE `feed:deltas`.
 *
 * A popular post at a live event attracts stakes faster than any UI should re-render. Emitting
 * per vote would push that storm straight to every connected client, and each one would rerender
 * the whole feed dozens of times a second.
 *
 * So changes are gathered for a short window and sent together: every total that moved, plus
 * the FULL authoritative order. Sending the whole order rather than a diff is what stops a
 * client drifting — it never has to work out the ranking, only render what it is given.
 *
 * Batching lives here rather than in the votes module because it is a transport concern: the
 * vote service says "this post changed", and this decides how often that reaches anyone.
 */
const { emitToEvent } = require('./socket');

// Long enough to collapse a burst, short enough to still feel immediate.
const BATCH_MS = 300;

// eventId -> { postIds: Set, timer }. One pending batch per event, so a busy event cannot
// delay a quiet one.
const pending = new Map();

/**
 * Note that some posts in an event changed, and make sure a batch is on its way.
 *
 * `resolve(eventId)` is called when the timer fires — NOT now — so the payload always carries
 * the ranking as it stands at send time rather than when the first vote in the batch landed.
 */
function queueFeedChange(eventId, postIds, resolve) {
  const key = String(eventId);
  const batch = pending.get(key) ?? { postIds: new Set(), timer: null };
  postIds.forEach((id) => batch.postIds.add(String(id)));

  if (!batch.timer) {
    batch.timer = setTimeout(async () => {
      pending.delete(key);
      try {
        const payload = await resolve(eventId, [...batch.postIds]);
        if (payload) emitToEvent(eventId, 'feed:deltas', payload);
      } catch (err) {
        // A failed broadcast must never take the process down: the votes themselves are
        // already committed, and the next batch (or a reconnect refetch) corrects the view.
        console.warn('[feed] Delta broadcast failed:', err.message);
      }
    }, BATCH_MS);
    // Do not hold the process open for a pending batch — matters for tests and for shutdown.
    if (typeof batch.timer.unref === 'function') batch.timer.unref();
  }

  pending.set(key, batch);
}

/** Drop every pending batch. Used by tests so one file cannot leak a timer into the next. */
function clearPendingBatches() {
  pending.forEach((batch) => clearTimeout(batch.timer));
  pending.clear();
}

module.exports = { queueFeedChange, clearPendingBatches, BATCH_MS };
