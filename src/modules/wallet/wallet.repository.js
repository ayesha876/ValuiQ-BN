/**
 * wallet.repository.js — the ONLY file that talks to the Wallet and LedgerEntry collections.
 *
 * The service says WHAT should happen ("take 100 tokens if they have them"); this file knows
 * HOW. That matters more here than elsewhere: the atomicity guarantee this whole module rests
 * on is a property of one query below, and keeping it in one place means it cannot be
 * accidentally re-implemented as a read-then-write somewhere else.
 */
const mongoose = require('mongoose');
const { Wallet, LedgerEntry } = require('./wallet.model');

/**
 * Fetch a user's wallet, creating it on first touch.
 *
 * `upsert` + the unique index on `user` makes this safe under concurrency: two simultaneous
 * first-touches race, one wins, the other gets a duplicate-key error and reads the winner's
 * document. Same idiom as moderator.repository's membership upsert.
 */
async function getOrCreate(userId) {
  try {
    return await Wallet.findOneAndUpdate(
      { user: userId },
      { $setOnInsert: { user: userId } },
      { new: true, upsert: true },
    );
  } catch (err) {
    // Lost the create race — the wallet now exists, so just read it.
    if (err.code === 11000) return Wallet.findOne({ user: userId });
    throw err;
  }
}

function findByUser(userId) {
  return Wallet.findOne({ user: userId });
}

/**
 * ⚠️ THE ATOMIC DEBIT. The single most important query in this codebase.
 *
 * The affordability check is the FILTER, not a preceding read. Mongo matches and updates one
 * document atomically, so there is no window in which two concurrent requests can both decide
 * a balance is sufficient and both spend it. A read-then-write here — however carefully
 * written — would let exactly that happen under load, and would pass every single-threaded
 * test while doing so.
 *
 * Returns the updated wallet, or NULL when the balance could not cover it. Null is an answer,
 * not an error: the caller turns it into a 409.
 */
function debitIfSufficient(userId, amount) {
  return Wallet.findOneAndUpdate(
    { user: userId, balance: { $gte: amount } },
    { $inc: { balance: -amount, lifetimeSpent: amount } },
    { new: true },
  );
}

/**
 * Add tokens. No condition needed — a credit can never be refused.
 *
 * `lifetimeKey` records which bucket the tokens came from (granted vs purchased) so the
 * running totals stay meaningful; a refund belongs to neither and passes null.
 */
function credit(userId, amount, lifetimeKey = null) {
  const inc = { balance: amount };
  if (lifetimeKey) inc[lifetimeKey] = amount;

  return Wallet.findOneAndUpdate(
    { user: userId },
    { $inc: inc },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

/** Write the intent to move tokens, before any tokens move. */
function createPendingEntry(entry) {
  return LedgerEntry.create({ ...entry, status: 'pending', balanceAfter: null });
}

/** Record that the movement happened, and what the balance became. */
function markApplied(entryId, balanceAfter) {
  return LedgerEntry.findByIdAndUpdate(entryId, { status: 'applied', balanceAfter }, { new: true });
}

/** Record that it did not happen — a refusal leaves a trace, not a silence. */
function markFailed(entryId) {
  return LedgerEntry.findByIdAndUpdate(entryId, { status: 'failed' }, { new: true });
}

/** The already-recorded result of an idempotency key, for replaying a retried request. */
function findByIdempotencyKey(idempotencyKey) {
  return LedgerEntry.findOne({ idempotencyKey });
}

/** One user's movements, newest first — served by the { user, createdAt } index. */
function findEntriesByUser(userId, { limit = 50 } = {}) {
  return LedgerEntry.find({ user: userId }).sort({ createdAt: -1 }).limit(limit).lean();
}

/**
 * Sum of every APPLIED movement for a user. Used to prove the ledger and the balance agree —
 * pending and failed rows are excluded because neither moved any tokens.
 */
async function sumAppliedByUser(userId) {
  const [row] = await LedgerEntry.aggregate([
    { $match: { user: userId, status: 'applied' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row?.total ?? 0;
}

/**
 * Lifetime PURCHASE totals for a set of users — tokens bought and cents actually paid.
 *
 * This is the input to a host's earnings: a token is worth what its owner paid for it on
 * average (QinMvpDocs §6), so settling one post needs this for every attendee who staked on
 * it. Batched over an array rather than exposed per-user because the alternative is one
 * aggregate per staker, and a popular post has dozens.
 *
 * GRANTS ARE EXCLUDED, and that is the point of matching on `type: 'purchase'`. Granted tokens
 * were never paid for; averaging them in would drag the rate toward zero and understate what
 * the audience genuinely spent. `status: 'applied'` excludes pending and failed rows, neither
 * of which moved anything.
 *
 * Amounts are stored SIGNED and a purchase is a credit, so `amount` is already positive here.
 *
 * @param {Array<string|import('mongoose').Types.ObjectId>} userIds - Attendees to total.
 * @returns {Promise<Map<string, {purchasedTokens: number, purchasedCents: number}>>}
 *   Keyed by user id as a string. Users with no purchases are simply absent — callers treat a
 *   miss as a zero rate rather than an error.
 */
async function purchaseTotalsByUsers(userIds = []) {
  if (!userIds.length) return new Map();

  const ids = userIds.map((id) => new mongoose.Types.ObjectId(String(id)));

  const rows = await LedgerEntry.aggregate([
    { $match: { user: { $in: ids }, type: 'purchase', status: 'applied' } },
    {
      $group: {
        _id: '$user',
        purchasedTokens: { $sum: '$amount' },
        // fiatCents is null on anything that is not a purchase; $sum ignores nulls, and the
        // match above has already excluded every other type.
        purchasedCents: { $sum: '$fiatCents' },
      },
    },
  ]);

  return new Map(
    rows.map((row) => [
      row._id.toString(),
      { purchasedTokens: row.purchasedTokens ?? 0, purchasedCents: row.purchasedCents ?? 0 },
    ]),
  );
}

/**
 * Every refund issued against one post.
 *
 * This is the "AttendeeRefund records" view. It is a query rather than a collection on
 * purpose — see the header of revenue.model.js for why a second copy of refund data was
 * rejected.
 *
 * @param {string|import('mongoose').Types.ObjectId} postId - The settled post.
 * @returns {Promise<Array<object>>} Applied refund ledger entries, newest first.
 */
function findRefundsForPost(postId) {
  return LedgerEntry.find({ 'ref.postId': postId, type: 'refund', status: 'applied' })
    .sort({ createdAt: -1 })
    .lean();
}

module.exports = {
  getOrCreate,
  findByUser,
  purchaseTotalsByUsers,
  findRefundsForPost,
  debitIfSufficient,
  credit,
  createPendingEntry,
  markApplied,
  markFailed,
  findByIdempotencyKey,
  findEntriesByUser,
  sumAppliedByUser,
};
