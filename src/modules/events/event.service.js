/**
 * event.service.js — the BUSINESS LOGIC for events (HTTP-agnostic).
 *
 * Decides WHAT should happen (slug generation, draft-vs-go-live rules, ownership),
 * and calls the repository for anything that touches the database. It never uses
 * req/res and never writes Mongoose queries directly.
 */
const crypto = require('crypto');
const AppError = require('../../shared/utils/errors');
const repo = require('./event.repository');
// moderator.service only depends on event.repository (never event.service), so this
// import is one-directional — no circular dependency.
const moderatorService = require('../moderators/moderator.service');

// System words a custom slug may NOT use — they'd collide with app routes or read
// as an official page. Checked for BOTH custom and auto-generated slugs.
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'auth', 'login', 'logout', 'register', 'dashboard', 'events',
  'event', 'create', 'settings', 'profile', 'account', 'wallet', 'moderator',
  'moderators', 'invite', 'accept-invite', 'forgot-password', 'reset-password',
  'set-password', 'verify-email', 'verify-otp', 'password-reset-success', 'health',
  'socket', 'static', 'assets', 'public', 'help', 'support', 'about', 'terms',
  'privacy',
]);

const isReservedSlug = (slug) => RESERVED_SLUGS.has(slug);

// --- small helpers -------------------------------------------------------

// Turn an event name into a URL-safe slug base (lowercase, dashes, trimmed).
function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'event';
}

// A short random suffix for slug de-duplication.
const randomSuffix = () => crypto.randomBytes(3).toString('hex'); // 6 hex chars

// Find a slug that is neither reserved nor taken. Falls back to name-<suffix>.
async function generateUniqueSlug(name) {
  const base = slugify(name);
  let candidate = base;
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!isReservedSlug(candidate) && !(await repo.existsBySlug(candidate))) {
      return candidate;
    }
    candidate = `${base}-${randomSuffix()}`;
  }
  return `${base}-${randomSuffix()}${randomSuffix()}`;
}

// Drop keys whose value is undefined so a partial update never wipes a field the
// client didn't send.
const pruneUndefined = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// Mongoose subdoc -> plain object (for shallow-merging nested config on update).
const toPlain = (v) => (v && typeof v.toObject === 'function' ? v.toObject() : v || {});

// Map intent -> server-owned status. A future start date means "scheduled".
function resolveStatus(intent, startDate) {
  if (intent !== 'live') return 'draft';
  if (startDate && new Date(startDate).getTime() > Date.now()) return 'scheduled';
  return 'live';
}

// A draft may be incomplete, but going live requires the full set. Reads the same
// shape from both a create payload and a loaded event doc (== null allows 0).
function assertGoLiveReady(data) {
  const missing = [];
  if (!data.startDate) missing.push('start date');
  if (!data.endDate) missing.push('end date');
  if (data.pricing?.minPostCost == null) missing.push('minimum post cost');
  if (data.pricing?.minVoteCost == null) missing.push('minimum vote cost');
  if (missing.length) {
    throw new AppError(400, `Cannot go live — please set: ${missing.join(', ')}.`);
  }
}

// After an event is persisted, mirror any create/edit-form moderator rows (the
// embedded `moderators` array) into the invite system so they appear in the host's
// Moderators view as PENDING. Best-effort: the sync itself already isolates each
// moderator, and this extra guard means even a total failure never undoes a
// successfully-saved event. No-op when there are no moderators.
async function bridgeFormModeratorsToInvites({ event, moderators, inviter }) {
  if (!moderators?.length) return;
  try {
    await moderatorService.syncFormModeratorsToInvites({ event, moderators, inviter });
  } catch (err) {
    console.warn('[events] Moderator invite sync failed (event still saved):', err.message);
  }
}

// --- use cases (one per endpoint) ---------------------------------------

/**
 * CREATE — assemble a trusted document: owner from the token, slug validated (or
 * generated), status derived from intent.
 *
 * Slug rules:
 *  - Custom slug (from the client, already sanitized by Zod): reject if reserved
 *    (400) or taken (409). Never silently suffixed — the user chose that link.
 *  - No slug: auto-generate from the name, retrying on the rare 11000 race so a
 *    duplicate never surfaces as the shared handler's generic message.
 */
async function createEvent({ user, data }) {
  const { intent = 'draft', slug: requestedSlug, ...fields } = data;
  if (intent === 'live') assertGoLiveReady(fields);
  const status = resolveStatus(intent, fields.startDate);

  if (requestedSlug) {
    if (isReservedSlug(requestedSlug)) {
      throw new AppError(400, 'This link is reserved and can’t be used. Choose another.');
    }
    if (await repo.existsBySlug(requestedSlug)) {
      throw new AppError(409, 'This link is already taken. Choose another.');
    }
    let created;
    try {
      created = await repo.create({ ...fields, owner: user.id, slug: requestedSlug, status });
    } catch (err) {
      // Lost the race between the check and the insert -> still a clear 409.
      if (err.code === 11000) {
        throw new AppError(409, 'This link is already taken. Choose another.');
      }
      throw err;
    }
    await bridgeFormModeratorsToInvites({ event: created, moderators: fields.moderators, inviter: user });
    return created;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const slug = await generateUniqueSlug(fields.name);
    let created;
    try {
      // eslint-disable-next-line no-await-in-loop
      created = await repo.create({ ...fields, owner: user.id, slug, status });
    } catch (err) {
      if (err.code === 11000 && attempt < 2) continue; // slug race — try again
      throw err;
    }
    // eslint-disable-next-line no-await-in-loop
    await bridgeFormModeratorsToInvites({ event: created, moderators: fields.moderators, inviter: user });
    return created;
  }
  // Unreachable in practice (loop returns or throws), but satisfies the linter.
  throw new AppError(500, 'Could not create event. Please try again.');
}

/** LIST — only the caller's own events, paginated, newest first, with optional
 * name search + status filter (both applied in the DB query). */
async function listEvents({ user, page, limit, search, status }) {
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    repo.findByOwnerPaginated(user.id, { skip, limit, status, search }),
    repo.countByOwner(user.id, { status, search }),
  ]);
  // .lean() rows keep _id/__v — normalize to the { id, ... } shape the FE expects.
  const events = rows.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest }));
  return {
    events,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/** GET ONE — 404 if it doesn't exist, 403 if it isn't yours (IDOR guard). */
async function getEvent({ user, id }) {
  const event = await repo.findActiveById(id);
  if (!event) throw new AppError(404, 'Event not found.');
  if (event.owner.toString() !== user.id) {
    throw new AppError(403, 'You do not have permission to view this event.');
  }
  return event;
}

/** UPDATE — ownership-checked partial update; slug stays fixed (stable link). */
async function updateEvent({ user, id, data }) {
  const event = await repo.findActiveById(id);
  if (!event) throw new AppError(404, 'Event not found.');
  if (event.owner.toString() !== user.id) {
    throw new AppError(403, 'You do not have permission to modify this event.');
  }
  // Rules lock once an event leaves draft. Going live is still fine (it starts as
  // a draft, so this guard passes and the intent transition below runs).
  if (event.status !== 'draft') {
    throw new AppError(409, 'Only draft events can be edited.');
  }

  const { intent, segment, pricing, ...scalars } = data;

  Object.assign(event, pruneUndefined(scalars));
  if (segment) event.segment = { ...toPlain(event.segment), ...pruneUndefined(segment) };
  if (pricing) event.pricing = { ...toPlain(event.pricing), ...pruneUndefined(pricing) };

  // Status only changes on an explicit intent.
  if (intent === 'live') {
    assertGoLiveReady(event);
    event.status = resolveStatus('live', event.startDate);
  } else if (intent === 'draft') {
    event.status = 'draft';
  }

  const saved = await repo.save(event);
  // Only bridge when this update actually carried moderator rows (undefined = the
  // caller didn't touch moderators, so there's nothing to sync).
  await bridgeFormModeratorsToInvites({ event: saved, moderators: data.moderators, inviter: user });
  return saved;
}

/** SOFT DELETE — ownership-checked; only draft or ended events; keeps the doc so
 * ended events' token/payment history stays recoverable. */
async function deleteEvent({ user, id }) {
  const event = await repo.findActiveById(id);
  if (!event) throw new AppError(404, 'Event not found.');
  if (event.owner.toString() !== user.id) {
    throw new AppError(403, 'You do not have permission to delete this event.');
  }
  if (event.status !== 'draft' && event.status !== 'ended') {
    throw new AppError(409, 'A running event can’t be deleted.');
  }
  event.deletedAt = new Date();
  await repo.save(event);
  return event;
}

module.exports = { createEvent, listEvents, getEvent, updateEvent, deleteEvent };
