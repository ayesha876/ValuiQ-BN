/**
 * event.repository.js — the ONLY file that talks to the Event collection.
 *
 * The service says WHAT it wants ("list this owner's events, page 2"); this file
 * knows HOW (Mongoose queries, .lean(), pagination). If storage ever changes, only
 * this file changes.
 */
const Event = require('./event.model');

// Escape user input so it's matched LITERALLY inside a regex — neutralizes ReDoS
// (no attacker-controlled quantifiers) and treats special chars as plain text.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build the owner-scoped read filter shared by list + count. Always excludes
// soft-deleted docs; status/search are optional and applied in the DB query.
function buildOwnerQuery(ownerId, { status, search } = {}) {
  const query = { owner: ownerId, deletedAt: null };
  if (status) query.status = status;
  if (search) query.name = { $regex: escapeRegex(search), $options: 'i' };
  return query;
}

// Create a new event document from a fully-assembled payload (owner/slug/status
// already set by the service — never from the client).
function create(data) {
  return Event.create(data);
}

// One page of the owner's (non-deleted, optionally filtered) events, newest first.
// .lean() returns plain JS objects (no Mongoose overhead) since list rows are
// read-only — the fast path, served by the { owner:1, createdAt:-1 } index.
function findByOwnerPaginated(ownerId, { skip, limit, status, search }) {
  return Event.find(buildOwnerQuery(ownerId, { status, search }))
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

// Count matching the SAME filter, so pagination totals reflect the filtered set.
function countByOwner(ownerId, { status, search } = {}) {
  return Event.countDocuments(buildOwnerQuery(ownerId, { status, search }));
}

// A single ACTIVE event by id (excludes soft-deleted). Full Mongoose doc so the
// service can mutate + save (update / soft-delete); toJSON maps _id -> id on output.
function findActiveById(id) {
  return Event.findOne({ _id: id, deletedAt: null });
}

// Check that a slug is free before assigning it (service uses this when generating
// a unique slug).
function existsBySlug(slug) {
  return Event.exists({ slug });
}

// Persist changes made to an event document we already loaded (runs validators).
function save(eventDoc) {
  return eventDoc.save();
}

module.exports = {
  create,
  findByOwnerPaginated,
  countByOwner,
  findActiveById,
  existsBySlug,
  save,
};
