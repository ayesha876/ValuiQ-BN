/**
 * wallet.service.js — the BUSINESS LOGIC for tokens (HTTP-agnostic).
 *
 * Posts and votes call `debit`. Grants and (later) Stripe purchases call `credit`. Nothing
 * else may move a balance — this is the one door, so there is one place to audit.
 *
 * ── THE WRITE ORDER, AND WHY IT IS THIS WAY ───────────────────────────────────────────────
 * There are no transactions here (single-document atomicity is all this needs, and sessions
 * would require a replica set the test runner does not provide). So a debit is two writes, and
 * the order is chosen for what happens if the process dies between them:
 *
 *   1. Write the ledger row as `pending`.
 *   2. Conditionally debit — the balance guard lives in the query, so it is atomic.
 *   3. Mark the row `applied` with the resulting balance.
 *
 * Crash after 1: a `pending` row, no money moved. Harmless, and visible.
 * Crash after 2: a `pending` row and money that DID move. Wrong, but visible and repairable —
 * the row says exactly what was attempted, for whom, and how much.
 *
 * The inverse order (debit first) would make that second case invisible: tokens gone, nothing
 * written down, nothing to reconcile against. Visible-and-wrong beats silent-and-wrong.
 *
 * ⚠️ Nothing repairs `pending` rows yet — see the note at the bottom of this file.
 */
const AppError = require('../../shared/utils/errors');
const repo = require('./wallet.repository');

// Which lifetime total a credit belongs to. A refund belongs to neither: it returns tokens
// that were already counted as granted or purchased when they first arrived.
const LIFETIME_BUCKET = {
  grant: 'lifetimeGranted',
  purchase: 'lifetimePurchased',
};

/** Reject anything that is not a positive whole number of tokens before it reaches the DB. */
function assertValidAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError(400, 'Token amount must be a whole number greater than zero.');
  }
}

/**
 * A replayed request returns its ORIGINAL result rather than moving tokens again.
 *
 * `applied` replays the original outcome. `failed` replays the original refusal — a retry of
 * a request that could not be afforded must not succeed just because the balance has since
 * been topped up; that would make the same key mean two different things.
 *
 * `pending` is the crash case: we cannot tell whether the money moved, so we refuse rather
 * than risk double-spending, and say so in terms someone can act on.
 */
async function replayIfKnown(idempotencyKey) {
  if (!idempotencyKey) return null;

  const existing = await repo.findByIdempotencyKey(idempotencyKey);
  if (!existing) return null;

  if (existing.status === 'applied') {
    return { balance: existing.balanceAfter, entry: existing, replayed: true };
  }
  if (existing.status === 'failed') {
    throw new AppError(409, 'Not enough tokens for this.');
  }
  throw new AppError(409, 'This request is still being processed. Please try again in a moment.');
}

/**
 * Spend tokens. Throws 409 when the balance cannot cover it — which is a normal outcome, not
 * an exceptional one, and the message is written to be shown to a person.
 */
async function debit({ userId, amount, type, idempotencyKey = null, ref = {} }) {
  assertValidAmount(amount);

  const replay = await replayIfKnown(idempotencyKey);
  if (replay) return replay;

  // Ensure the wallet exists before writing intent against it, so a first-time spender gets a
  // clean "not enough tokens" rather than a confusing missing-wallet error.
  await repo.getOrCreate(userId);

  let entry;
  try {
    entry = await repo.createPendingEntry({
      user: userId,
      type,
      amount: -amount, // signed: the ledger sums to the balance
      idempotencyKey,
      ref,
    });
  } catch (err) {
    // Two identical requests raced past the replay check. The other one owns this movement;
    // re-reading it gives the same answer rather than spending twice.
    if (err.code === 11000) {
      const settled = await replayIfKnown(idempotencyKey);
      if (settled) return settled;

      // The duplicate is real but the winning row is not readable yet. Answer explicitly —
      // otherwise this reaches the shared error handler, which maps EVERY duplicate-key error
      // to "Email already registered." A wallet retry must never say that.
      throw new AppError(409, 'This request is already being processed. Please try again in a moment.');
    }
    throw err;
  }

  const wallet = await repo.debitIfSufficient(userId, amount);

  if (!wallet) {
    await repo.markFailed(entry.id);
    throw new AppError(409, 'Not enough tokens for this.');
  }

  const applied = await repo.markApplied(entry.id, wallet.balance);
  return { balance: wallet.balance, entry: applied, replayed: false };
}

/**
 * Add tokens. `fiatCents` is what was actually paid, and is required for a purchase: without
 * it a host's earnings cannot be calculated later (QinMvpDocs §6), and unlike most missing
 * data it cannot be reconstructed after the fact.
 */
async function credit({ userId, amount, type, idempotencyKey = null, ref = {}, fiatCents = null }) {
  assertValidAmount(amount);

  if (type === 'purchase' && fiatCents == null) {
    throw new AppError(400, 'A purchase must record what was paid.');
  }

  const replay = await replayIfKnown(idempotencyKey);
  if (replay) return replay;

  let entry;
  try {
    entry = await repo.createPendingEntry({ user: userId, type, amount, idempotencyKey, ref, fiatCents });
  } catch (err) {
    if (err.code === 11000) {
      const settled = await replayIfKnown(idempotencyKey);
      if (settled) return settled;
    }
    throw err;
  }

  const wallet = await repo.credit(userId, amount, LIFETIME_BUCKET[type] ?? null);
  const applied = await repo.markApplied(entry.id, wallet.balance);
  return { balance: wallet.balance, entry: applied, replayed: false };
}

/** Current balance, creating the wallet on first read so a new user sees 0 rather than an error. */
async function getBalance(userId) {
  const wallet = await repo.getOrCreate(userId);
  return wallet.balance;
}

/** Recent movements, newest first. */
function getHistory(userId, options) {
  return repo.findEntriesByUser(userId, options);
}

module.exports = { debit, credit, getBalance, getHistory };

/**
 * DEFERRED — no reconciliation sweep exists.
 *
 * The ordering above guarantees a crash is VISIBLE (a `pending` row that never settled), but
 * nothing yet repairs one. A sweep would: find `pending` rows older than a few minutes, check
 * whether the balance reflects them, and either apply or fail them. `src/jobs/queues/
 * recoveryQueue.js` and its worker are the existing stubs where that belongs. Small, separate,
 * and worth doing before real money is involved.
 */
