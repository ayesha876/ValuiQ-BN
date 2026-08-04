/**
 * attendee.service.js — what an attendee sees when they open the app (HTTP-agnostic).
 *
 * ── "EVENTS I CAN JOIN" DID NOT EXIST, AND THIS IS THE NARROWEST HONEST ANSWER ────────────
 * Events are owner-scoped. There is no public index, no browse, and no attendee↔event relation
 * until a person actually takes part — attendees reach an event by following a link. So
 * "my events" is defined here as EVENTS THIS PERSON HAS PARTICIPATED IN: they posted, or they
 * staked on someone else's post.
 *
 * The alternative — listing every `status: 'live'` event — was rejected deliberately. It would
 * make every host's event publicly discoverable by every account on the platform, which is a
 * product decision nobody has taken, and an irreversible one to ship by accident.
 *
 * The consequence, stated plainly so the empty state can say it: a brand-new attendee sees
 * nothing here until they follow their first event link. That is correct, not a gap.
 */
const mongoose = require('mongoose');
const Post = require('../posts/post.model');
const Vote = require('../votes/vote.model');
const Event = require('../events/event.model');
const EventMember = require('../moderators/eventMember.model');
const walletService = require('../wallet/wallet.service');
const { windowFor } = require('../posts/post.service');
const { displayNameFor } = require('../../shared/utils/displayName');

/** Event ids this user has taken part in, by either route into a feed. */
async function participatedEventIds(userId) {
  const [posted, voted] = await Promise.all([
    Post.distinct('event', { author: userId }),
    Vote.distinct('event', { voter: userId }),
  ]);

  // De-duplicated as strings: the same event reached both ways is still one event.
  return [...new Set([...posted, ...voted].map(String))];
}

/**
 * How many distinct people have taken part in each event.
 *
 * Two aggregations for the whole page rather than two queries per row — the N+1 this replaces
 * would have been invisible at three events and painful at thirty.
 */
async function participantCounts(eventIds) {
  const ids = eventIds.map((id) => new mongoose.Types.ObjectId(id));

  const [byPost, byVote] = await Promise.all([
    Post.aggregate([{ $match: { event: { $in: ids } } }, { $group: { _id: '$event', users: { $addToSet: '$author' } } }]),
    Vote.aggregate([{ $match: { event: { $in: ids } } }, { $group: { _id: '$event', users: { $addToSet: '$voter' } } }]),
  ]);

  const merged = new Map();
  for (const row of [...byPost, ...byVote]) {
    const key = String(row._id);
    const set = merged.get(key) ?? new Set();
    row.users.forEach((u) => set.add(String(u)));
    merged.set(key, set);
  }

  return new Map([...merged].map(([key, set]) => [key, set.size]));
}

/**
 * Who is answering, per event: the host plus every active moderator.
 *
 * One query for the members, one for the users behind them — again batched across the page.
 */
async function moderatorNames(events) {
  const eventIds = events.map((e) => e._id);
  const members = await EventMember.find({ event: { $in: eventIds }, status: 'active' })
    .select('user event')
    .lean();

  const userIds = [...new Set([...members.map((m) => String(m.user)), ...events.map((e) => String(e.owner))])];
  const users = await mongoose.model('User').find({ _id: { $in: userIds } }).select('email').lean();
  const nameById = new Map(users.map((u) => [String(u._id), displayNameFor(u, 'Moderator')]));

  const byEvent = new Map();
  for (const event of events) {
    // The host first — they own the event and answer for it.
    const names = [nameById.get(String(event.owner))].filter(Boolean);
    byEvent.set(String(event._id), names);
  }
  for (const member of members) {
    const key = String(member.event);
    const name = nameById.get(String(member.user));
    const names = byEvent.get(key);
    if (name && names && !names.includes(name)) names.push(name);
  }

  return byEvent;
}

/**
 * The attendee's dashboard: every event they have taken part in, most recently started first.
 *
 * `postingOpen` is the single flag the UI gates its Join button on. It is true only when the
 * event is live AND the current participation window has not closed — a live event whose window
 * has run out accepts nothing, and a Join button that leads to a closed arena is a lie.
 *
 * @param {string} userId - The signed-in attendee.
 * @returns {Promise<{events: Array<object>}>}
 */
async function getMyEvents(userId) {
  const eventIds = await participatedEventIds(userId);
  if (!eventIds.length) return { events: [] };

  const events = await Event.find({ _id: { $in: eventIds }, deletedAt: null })
    .sort({ roundStartedAt: -1, createdAt: -1 })
    .lean();

  if (!events.length) return { events: [] };

  const [counts, moderators] = await Promise.all([
    participantCounts(events.map((e) => String(e._id))),
    moderatorNames(events),
  ]);

  const now = Date.now();

  return {
    events: events.map((event) => {
      const window = windowFor(event);
      const endsAt = window?.endsAt ? new Date(window.endsAt).getTime() : null;
      const windowOpen = endsAt == null ? event.status === 'live' : endsAt > now;

      return {
        id: String(event._id),
        name: event.name,
        slug: event.slug,
        bannerUrl: event.bannerUrl || '',
        status: event.status,
        // The two things the card's call-to-action depends on.
        postingOpen: event.status === 'live' && windowOpen,
        endsAt: window?.endsAt ?? null,
        secondsRemaining: endsAt == null ? null : Math.max(Math.round((endsAt - now) / 1000), 0),
        attendeeCount: counts.get(String(event._id)) ?? 0,
        moderators: moderators.get(String(event._id)) ?? [],
        startDate: event.startDate ?? null,
      };
    }),
  };
}

/**
 * The attendee's token balance.
 *
 * Straight from the wallet, which creates one on first read — a new account sees 0 rather than
 * an error. Tokens are the in-app currency, NOT cents: never render this with a currency symbol.
 *
 * @param {string} userId - The signed-in attendee.
 * @returns {Promise<{balance: number}>}
 */
async function getTokenBalance(userId) {
  return { balance: await walletService.getBalance(userId) };
}

module.exports = { getMyEvents, getTokenBalance };
