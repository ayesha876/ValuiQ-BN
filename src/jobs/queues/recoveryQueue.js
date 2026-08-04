/**
 * recoveryQueue.js — STUB (intentionally empty for now).
 *
 * Abandoned/unverified "ghost" accounts are cleaned up by a MongoDB TTL index on
 * the User model's `expiresAt` field (see src/modules/auth/auth.model.js). That
 * approach needs no queue or worker, so this BullMQ queue is left unimplemented.
 *
 * Implement this only if future cleanup outgrows a simple TTL — e.g. cascading
 * deletes across several collections when an account is removed.
 */
module.exports = {};
