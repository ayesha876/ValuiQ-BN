/**
 * recovery.worker.js — STUB (intentionally empty for now).
 *
 * Cleanup of unverified accounts is handled by a MongoDB TTL index (see
 * src/modules/auth/auth.model.js `expiresAt`), so no background worker is needed
 * for the registration module. This file is a placeholder for future cleanup
 * jobs that a TTL index can't express (see recoveryQueue.js).
 */
module.exports = {};
