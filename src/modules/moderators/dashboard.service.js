/**
 * dashboard.service.js — the moderator's landing view: every event they may work on.
 *
 * ── THIS ENDPOINT IS ALSO THE CAPABILITY CHECK ────────────────────────────────────────────
 * There is no global "is a moderator" flag to read. Authority is per-event: you either OWN the
 * event or you hold an active `EventMember` row for it. `moderation.routes.js` spells out why
 * the global `'Moderator'` role must not be used for this —
 *
 *   "gating on the vestigial global 'Moderator' role would lock out every moderator who
 *    registered as an Attendee — which is most of them."
 *
 * So the frontend asks this endpoint "what do I moderate?" and treats a non-empty answer as the
 * capability. An empty list is a valid, successful answer meaning "nothing yet" — never a 403.
 * Refusing here would make the honest case (an invited moderator who has not accepted yet)
 * indistinguishable from a permissions failure.
 *
 * ── WHY pendingCount IS THE HEADLINE NUMBER ───────────────────────────────────────────────
 * A post left undecided is not merely untidy: its fairness timer is running, and when it expires
 * every staker is refunded and the host earns nothing. So the count of still-decidable posts is
 * the moderator's actual workload and the host's actual exposure, which is why the dashboard
 * polls it rather than showing it once.
 */
const mongoose = require('mongoose');
const Event = require('../events/event.model');
const EventMember = require('./eventMember.model');
const Post = require('../posts/post.model');
const { DECIDABLE_STATUSES } = require('../posts/post.model');
const ModerationDecision = require('../moderation/moderation.model');
const { displayNameFor } = require('../../shared/utils/displayName');

/** Posts still awaiting a decision, per event — one query for the whole page. */
async function pendingCounts(eventIds) {
  const rows = await Post.aggregate([
    { $match: { event: { $in: eventIds }, status: { $in: DECIDABLE_STATUSES } } },
    { $group: { _id: '$event', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

/**
 * What has already been settled, per event, broken down by outcome.
 *
 * Reported in this product's own vocabulary — addressed / dismissed / neglected — rather than
 * squeezed into "approved / rejected". Those three are not two: a neglected post refunded every
 * staker and earned the host nothing, which is a materially different event from a dismissal,
 * and a moderator reviewing their own work needs to see which happened.
 */
async function decisionCounts(eventIds) {
  const rows = await ModerationDecision.aggregate([
    { $match: { event: { $in: eventIds }, status: 'applied' } },
    { $group: { _id: { event: '$event', decision: '$decision' }, count: { $sum: 1 } } },
  ]);

  const byEvent = new Map();
  for (const row of rows) {
    const key = String(row._id.event);
    const tally = byEvent.get(key) ?? { addressed: 0, dismissed: 0, neglected: 0, total: 0 };
    if (row._id.decision === 'address') tally.addressed += row.count;
    if (row._id.decision === 'dismiss') tally.dismissed += row.count;
    if (row._id.decision === 'neglect') tally.neglected += row.count;
    tally.total += row.count;
    byEvent.set(key, tally);
  }
  return byEvent;
}

/**
 * Every event this user may moderate, with their workload on each.
 *
 * @param {string} userId - The signed-in user.
 * @returns {Promise<{events: Array<object>}>} Empty list when they moderate nothing.
 */
async function getModeratedEvents(userId) {
  // Two sources of authority, unioned: ownership and an accepted invite.
  const memberships = await EventMember.find({ user: userId, status: 'active' }).select('event').lean();
  const memberEventIds = memberships.map((m) => String(m.event));

  const events = await Event.find({
    deletedAt: null,
    $or: [
      { owner: new mongoose.Types.ObjectId(String(userId)) },
      { _id: { $in: memberEventIds.map((id) => new mongoose.Types.ObjectId(id)) } },
    ],
  })
    .sort({ roundStartedAt: -1, createdAt: -1 })
    .lean();

  if (!events.length) return { events: [] };

  const objectIds = events.map((e) => e._id);
  const ownerIds = [...new Set(events.map((e) => String(e.owner)))];

  const [pending, decisions, owners] = await Promise.all([
    pendingCounts(objectIds),
    decisionCounts(objectIds),
    mongoose.model('User').find({ _id: { $in: ownerIds } }).select('email').lean(),
  ]);

  const hostNameById = new Map(owners.map((u) => [String(u._id), displayNameFor(u, 'Host')]));
  const memberSet = new Set(memberEventIds);

  return {
    events: events.map((event) => {
      const key = String(event._id);
      return {
        id: key,
        name: event.name,
        slug: event.slug,
        status: event.status,
        hostName: hostNameById.get(String(event.owner)) ?? 'Host',
        // How they got here — a host sees their own events beside ones they were invited to.
        isOwner: String(event.owner) === String(userId),
        isInvited: memberSet.has(key),
        pendingCount: pending.get(key) ?? 0,
        decisions: decisions.get(key) ?? { addressed: 0, dismissed: 0, neglected: 0, total: 0 },
        startTime: event.startDate ?? null,
        endTime: event.endDate ?? null,
      };
    }),
  };
}

module.exports = { getModeratedEvents };
