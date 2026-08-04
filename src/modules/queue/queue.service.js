/**
 * queue.service.js — the moderator's review queue (HTTP-agnostic).
 *
 * What a moderator sees, in the order they should work through it.
 *
 * ── "SEVERITY" DOES NOT EXIST IN THIS PRODUCT, SO IT IS DERIVED ───────────────────────────
 * The brief asked to sort by `severity` and show `reportCount`, which belong to a
 * content-flagging model: posts go live, users report them, a moderation queue forms from the
 * reports. ValuiQ is not that. Nobody reports anything — every paid post enters review on
 * submission, and the moderator's job is curation, not policing. There is no `severity` field
 * and no `reportCount` anywhere, and inventing a reporting system to populate them would be
 * building a feature nobody asked for.
 *
 * What the moderator actually needs to triage by is URGENCY: which post will time out first
 * and refund its stakers, and how much money walks out of the door when it does. So `severity`
 * is DERIVED from exactly that — time remaining against tokens at stake — and the API keeps the
 * name so the frontend contract in the brief still holds. `reportCount` is deliberately absent
 * rather than faked with a zero, because a field that is always 0 reads as "nobody reported
 * this" instead of "this concept does not exist here".
 *
 * ── ORDERING: MOST URGENT FIRST, TIE-BROKEN BY OLDEST ─────────────────────────────────────
 * The brief's "severity DESC, flaggedAt ASC (oldest high-severity first)" maps cleanly once
 * severity is urgency. A post about to expire with 5,000 tokens on it outranks a fresh one
 * with 50, and two equally urgent posts are worked oldest-first — which is both fairest to the
 * attendee who has waited longest and what `post.repository.findPending` already does.
 */
const revenueService = require('../revenue/revenue.service');
const Post = require('../posts/post.model');
const { DECIDABLE_STATUSES } = require('../posts/post.model');

/** Severity bands. Named rather than numeric so the frontend can style them directly. */
const SEVERITY = Object.freeze({ CRITICAL: 'critical', HIGH: 'high', NORMAL: 'normal', LOW: 'low' });

// Rank for sorting. Higher is more urgent.
const SEVERITY_RANK = Object.freeze({ critical: 3, high: 2, normal: 1, low: 0 });

/**
 * Hard ceiling on rows pulled into memory for one queue request.
 *
 * Severity is a function of NOW, so the sort cannot happen in MongoDB (see the note on
 * getReviewQueue) — which means every row fetched is also a row valued. 500 is far above any
 * realistic undecided queue and still bounds `status=ALL` on an event with a long history.
 */
const MAX_SCAN = 500;

/**
 * How urgent is this post?
 *
 * Two inputs, because either alone misleads: time-only would rank a nearly-expired post with
 * 10 tokens above a fresh one carrying 5,000, and money-only would let a large post expire
 * while the moderator worked through it.
 *
 * A post with no deadline can never be auto-neglected, so it is never urgent — it waits.
 *
 * @param {{neglectDeadlineAt: Date|null, tokens: number}} post - The post to rank.
 * @param {number} [now] - Clock override in ms, for tests.
 * @returns {{severity: string, secondsRemaining: number|null, expired: boolean}}
 *
 * @example
 * severityFor({ neglectDeadlineAt: in30s, tokens: 4000 }); // => { severity: 'critical', … }
 */
function severityFor(post, now = Date.now()) {
  if (!post.neglectDeadlineAt) {
    return { severity: SEVERITY.LOW, secondsRemaining: null, expired: false };
  }

  const secondsRemaining = Math.round((new Date(post.neglectDeadlineAt).getTime() - now) / 1_000);

  // Already past its deadline: the sweep is about to refund it. Nothing outranks that — a
  // moderator can still save it in the seconds before the next pass.
  if (secondsRemaining <= 0) {
    return { severity: SEVERITY.CRITICAL, secondsRemaining: 0, expired: true };
  }

  // Thresholds in seconds, chosen against the timers hosts actually set (commonly 30-300s).
  // A minute is genuinely "act now"; five minutes is "next"; beyond that it can wait.
  const heavilyStaked = (post.tokens ?? 0) >= 1_000;

  if (secondsRemaining <= 60) return { severity: SEVERITY.CRITICAL, secondsRemaining, expired: false };
  if (secondsRemaining <= 300) {
    return { severity: heavilyStaked ? SEVERITY.CRITICAL : SEVERITY.HIGH, secondsRemaining, expired: false };
  }
  return { severity: heavilyStaked ? SEVERITY.HIGH : SEVERITY.NORMAL, secondsRemaining, expired: false };
}

/**
 * Shape one row the way the control room renders it.
 *
 * `financialExposure` is the honest name for what is at risk: the tokens that go back to
 * attendees, and the real money the host does NOT earn, if this post times out. Both, because
 * they are different currencies owed to different people — collapsing them into one number
 * would hide which.
 */
function shapeRow(post, valuation, now) {
  const urgency = severityFor(post, now);
  const id = String(post._id ?? post.id);

  return {
    id,
    // Posts have no title in this product — the text IS the post. Truncated for a list row so
    // the queue stays scannable; the moderator opens the post to read it in full.
    title: post.text.length > 120 ? `${post.text.slice(0, 117)}…` : post.text,
    text: post.text,
    authorName: post.authorName,
    status: post.status,
    roundIndex: post.roundIndex,

    // `flaggedAt` in the brief's vocabulary. Here it is when the post entered review — which
    // is submission, since every paid post is reviewed.
    flaggedAt: new Date(post.createdAt).toISOString(),
    deadlineAt: post.neglectDeadlineAt ? new Date(post.neglectDeadlineAt).toISOString() : null,

    severity: urgency.severity,
    secondsRemaining: urgency.secondsRemaining,
    expired: urgency.expired,

    financialExposure: {
      // Tokens returned to stakers if this times out.
      tokensAtRisk: post.tokens ?? 0,
      stakerCount: valuation?.perStaker.length ?? 0,
      // Real money the host forfeits if this times out, in cents.
      hostForfeitCents: valuation?.totalCents ?? 0,
    },
  };
}

/**
 * The review queue for one event, ordered by urgency.
 *
 * ── WHY THE SORT IS IN JAVASCRIPT AND NOT THE DATABASE ────────────────────────────────────
 * This codebase filters and sorts in MongoDB everywhere else, on principle. Severity is the
 * exception because it is a function of NOW: the same document is `normal` at one moment and
 * `critical` sixty seconds later, with no write in between. There is no index that can express
 * that, and `$expr` against `$$NOW` would defeat every index on the collection.
 *
 * The FLAGGED set stays small by construction — undecided posts in ONE event — so this sorts
 * tens of rows, not thousands. `status=ALL` has no such bound: it includes every settled post
 * an event ever had, and each row costs a valuation (a vote read plus a wallet aggregate). So
 * the fetch is capped at MAX_SCAN rather than left open. `pagination.total` is still the true
 * count, so a client is told when it is seeing a bounded view rather than the whole history.
 *
 * If an event ever holds enough UNDECIDED posts for the sort to matter, the fix is a stored,
 * periodically-recomputed severity band, not a cleverer query.
 *
 * @param {object} input
 * @param {object} input.event - The event whose queue this is.
 * @param {number} [input.page] - 1-based page.
 * @param {number} [input.limit] - Page size.
 * @param {'flaggedAt'|'severity'} [input.sortBy] - Ordering. Severity is the default.
 * @param {'FLAGGED'|'ALL'} [input.status] - FLAGGED = still decidable; ALL includes settled.
 * @param {number} [input.now] - Clock override in ms, for tests.
 * @returns {Promise<{items: Array<object>, pagination: {page: number, limit: number, total: number, totalPages: number}}>}
 *
 * @example
 * await getReviewQueue({ event, page: 1, limit: 20, sortBy: 'severity', status: 'FLAGGED' });
 */
async function getReviewQueue({ event, page = 1, limit = 20, sortBy = 'severity', status = 'FLAGGED', now = Date.now() }) {
  const eventId = event._id ?? event.id;

  // 'FLAGGED' in the brief's vocabulary means "still awaiting a decision", which here is any
  // decidable status. 'ALL' includes settled posts so a moderator can review their own work.
  const query = { event: eventId };
  if (status === 'FLAGGED') query.status = { $in: DECIDABLE_STATUSES };

  const [rows, total] = await Promise.all([
    // Fetched oldest-first at the database level, which IS the final order when sortBy is
    // `flaggedAt` and is the tiebreak when it is `severity`. Capped so `status=ALL` on a long
    // event cannot turn one request into thousands of wallet aggregates — oldest-first means
    // the cap drops the NEWEST settled posts, which are the least urgent thing here.
    Post.find(query).sort({ createdAt: 1 }).limit(MAX_SCAN).lean(),
    Post.countDocuments(query),
  ]);

  // Value each post so the moderator can see what leaving it costs. Sequential inside
  // `valuePost` but parallel across posts — these are independent reads, unlike the money
  // writes in the settlement path.
  const valuations = await Promise.all(rows.map((post) => revenueService.valuePost(post)));

  const shaped = rows.map((post, index) => shapeRow(post, valuations[index], now));

  if (sortBy === 'severity') {
    shaped.sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (bySeverity !== 0) return bySeverity;
      // Equal urgency: oldest first. Fairest to whoever has waited longest, and it matches
      // what `findPending` already does for the simple queue.
      return new Date(a.flaggedAt) - new Date(b.flaggedAt);
    });
  }

  // Paginated after sorting, because the order depends on a value only computed here.
  const start = (page - 1) * limit;

  return {
    items: shaped.slice(start, start + limit),
    pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  };
}

/**
 * The snapshot a control room receives the moment it connects.
 *
 * Deliberately the same shape as page 1 of the REST endpoint: a client that renders the
 * snapshot and a client that renders the REST response run the same code, so the two can never
 * drift into showing subtly different queues.
 *
 * @param {object} event - The event being watched.
 * @param {{limit?: number}} [options] - Page size.
 * @returns {Promise<{items: Array<object>, pagination: object}>}
 */
function getSnapshot(event, { limit = 50 } = {}) {
  return getReviewQueue({ event, page: 1, limit, sortBy: 'severity', status: 'FLAGGED' });
}

/**
 * Queue rows that changed since a timestamp — the reconnection catch-up.
 *
 * Reads from MongoDB rather than replaying a buffer, which is what makes the socket layer
 * survive a restart: there is no in-memory history to lose. A client that was disconnected for
 * an hour gets the same answer as one that never connected.
 *
 * @param {object} event - The event being watched.
 * @param {Date} since - The client's last-seen timestamp.
 * @returns {Promise<{items: Array<object>, since: string}>} Rows touched since `since`.
 */
async function getChangesSince(event, since) {
  const rows = await Post.find({
    event: event._id ?? event.id,
    updatedAt: { $gt: since },
  })
    .sort({ createdAt: 1 })
    .lean();

  const valuations = await Promise.all(rows.map((post) => revenueService.valuePost(post)));
  const now = Date.now();

  return {
    items: rows.map((post, index) => shapeRow(post, valuations[index], now)),
    since: since.toISOString(),
  };
}

module.exports = { getReviewQueue, getSnapshot, getChangesSince, severityFor, shapeRow, SEVERITY };
