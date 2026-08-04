/**
 * revenue.repository.js — the ONLY file that talks to HostWallet and HostRevenueEntry.
 *
 * Every balance change here is a conditional or atomic update for the same reason the token
 * wallet's is: a read-modify-write on money loses concurrent updates, and a host settling
 * fifty posts at the end of an event is exactly the concurrent case.
 */
const mongoose = require('mongoose');
const { HostWallet, HostRevenueEntry } = require('./revenue.model');

/**
 * Fetch a host's earnings wallet, creating it on first touch.
 *
 * @param {string} hostId - The event owner.
 * @returns {Promise<object>} The host wallet document.
 */
async function getOrCreateWallet(hostId) {
  try {
    return await HostWallet.findOneAndUpdate(
      { host: hostId },
      { $setOnInsert: { host: hostId } },
      { new: true, upsert: true },
    );
  } catch (err) {
    // Lost the create race — it exists now, so read it.
    if (err.code === 11000) return HostWallet.findOne({ host: hostId });
    throw err;
  }
}

/**
 * Record earned money against a post, exactly once.
 *
 * Returns `{ created: false, entry }` when this post already has an entry, rather than
 * throwing. The unique index on `post` is the second guard on over-crediting (the first being
 * the moderation decision claim), and a caller that trips it is retrying, not misbehaving.
 *
 * @param {object} input - The entry to write.
 * @param {string} input.host
 * @param {string} input.event
 * @param {string} input.post
 * @param {'address'|'dismiss'} input.decision
 * @param {number} input.grossValueCents - Post value before any share was applied.
 * @param {number} input.sharePct - The event's host share.
 * @param {number} input.decisionPct - The outcome's multiplier.
 * @param {number} input.amountCents - What the host actually earned.
 * @returns {Promise<{created: boolean, entry: object}>}
 */
async function bookEntry(input) {
  try {
    const entry = await HostRevenueEntry.create({ ...input, status: 'booked' });
    return { created: true, entry };
  } catch (err) {
    if (err.code === 11000) {
      const existing = await HostRevenueEntry.findOne({ post: input.post });
      return { created: false, entry: existing };
    }
    throw err;
  }
}

/**
 * Add earned money to a host's spendable balance.
 *
 * Unconditional `$inc` with upsert — a credit can never be refused, and the upsert means a
 * host earning before their wallet was ever read still lands correctly.
 *
 * @param {string} hostId
 * @param {number} amountCents - Must be positive.
 * @returns {Promise<object>} The updated wallet.
 */
function creditWallet(hostId, amountCents) {
  return HostWallet.findOneAndUpdate(
    { host: hostId },
    { $inc: { pendingCents: amountCents, lifetimeBookedCents: amountCents } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

/**
 * ⚠️ THE CONDITIONAL DEBIT. Take money back off a host, but never below zero.
 *
 * The balance guard is the FILTER, mirroring `wallet.repository.debitIfSufficient`. Returns
 * null when the host no longer holds enough — which is a real case, not a theoretical one: a
 * host can be paid out (Week 6) between earning on a post and that post being reversed.
 *
 * Null is an answer, not an error. The caller voids the entry regardless and records that the
 * clawback could not be taken from the pending balance, because the alternative — a negative
 * pending balance — is worse than a visible discrepancy.
 *
 * `lifetimeBookedCents` is NOT decremented: it is a historical fact that the money was once
 * booked, and the void entry is the record of it being taken back.
 *
 * @param {string} hostId
 * @param {number} amountCents
 * @returns {Promise<object|null>} Updated wallet, or null when the balance could not cover it.
 */
function debitWalletIfSufficient(hostId, amountCents) {
  return HostWallet.findOneAndUpdate(
    { host: hostId, pendingCents: { $gte: amountCents } },
    { $inc: { pendingCents: -amountCents } },
    { new: true },
  );
}

/**
 * Void a booked entry, but only if it is still booked.
 *
 * The status is in the filter so a concurrent second reversal cannot void the same entry
 * twice and claw back the money twice — the same conditional-update idiom as the post settle.
 *
 * @param {string} postId - Reversal is addressed by post, which is the unique key.
 * @returns {Promise<object|null>} The voided entry, or null when there was nothing to void.
 */
function voidEntryForPost(postId) {
  return HostRevenueEntry.findOneAndUpdate(
    { post: postId, status: 'booked' },
    { $set: { status: 'voided', voidedAt: new Date() } },
    { new: true },
  );
}

/** The entry for one post, whatever its status. */
function findEntryForPost(postId) {
  return HostRevenueEntry.findOne({ post: postId });
}

/**
 * Totals by status for one host, in cents.
 *
 * Aggregated in the database rather than summed in JavaScript: a host with a season of events
 * has thousands of entries, and shipping them all to the app to add up is a load-all-then-
 * filter pattern this codebase avoids everywhere else.
 *
 * @param {string|import('mongoose').Types.ObjectId} hostId
 * @returns {Promise<{booked: number, voided: number, paid: number, entryCount: number}>}
 */
async function summaryForHost(hostId) {
  const rows = await HostRevenueEntry.aggregate([
    { $match: { host: new mongoose.Types.ObjectId(String(hostId)) } },
    { $group: { _id: '$status', total: { $sum: '$amountCents' }, count: { $sum: 1 } } },
  ]);

  const totals = { booked: 0, voided: 0, paid: 0, entryCount: 0 };
  for (const row of rows) {
    if (row._id in totals) totals[row._id] = row.total;
    totals.entryCount += row.count;
  }
  return totals;
}

/** One host's entries, newest first — the detail behind the summary. */
function findEntriesByHost(hostId, { limit = 50, status = null } = {}) {
  const query = { host: hostId };
  if (status) query.status = status;
  return HostRevenueEntry.find(query).sort({ createdAt: -1 }).limit(limit).lean();
}

module.exports = {
  getOrCreateWallet,
  bookEntry,
  creditWallet,
  debitWalletIfSufficient,
  voidEntryForPost,
  findEntryForPost,
  summaryForHost,
  findEntriesByHost,
};
