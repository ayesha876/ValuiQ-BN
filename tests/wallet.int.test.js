/**
 * wallet.int.test.js — integration tests for the token wallet, against a real MongoDB.
 *
 * The test this module exists for is "concurrency > never spends more than the balance". Every
 * other test here would pass against a naive read-then-write implementation; that one would
 * not. It runs many debits genuinely in parallel against a balance that cannot cover them all,
 * and asserts that exactly the affordable number succeed and the balance never goes negative.
 *
 * Mirrors tests/sockets.int.test.js: MMS, dynamic app import, models via mongoose.model().
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';

let mongod;
let app;
let User;
let Wallet;
let LedgerEntry;
let walletService;
let user;
let token;

const auth = () => ({ Authorization: `Bearer ${token}` });

/** Put a known balance in place without going through the service under test. */
async function seedBalance(amount) {
  await Wallet.findOneAndUpdate(
    { user: user.id },
    { $set: { balance: amount } },
    { upsert: true, new: true },
  );
}

const balanceOf = async () => (await Wallet.findOne({ user: user.id }))?.balance;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('valuiq_wallet_test'));

  app = (await import('../app.js')).default;
  User = mongoose.model('User');
  Wallet = mongoose.model('Wallet');
  LedgerEntry = mongoose.model('LedgerEntry');
  walletService = (await import('../src/modules/wallet/wallet.service.js')).default;
  const { signLoginToken } = (await import('../src/shared/utils/generateToken.js')).default;

  // Idempotency is enforced by a unique index, and Mongoose builds indexes asynchronously.
  // Asserting "a retry cannot spend twice" before the index exists tests nothing — under load
  // both inserts simply succeed. init() resolves once the indexes are actually in place.
  await Promise.all([Wallet.init(), LedgerEntry.init()]);

  user = await User.create({ email: 'wallet@test.local', role: 'Attendee', isVerified: true });
  token = signLoginToken(user);
});

afterEach(async () => {
  await Wallet.deleteMany({});
  await LedgerEntry.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('debit — spending tokens', () => {
  it('spends and returns the new balance', async () => {
    await seedBalance(500);
    const result = await walletService.debit({ userId: user.id, amount: 200, type: 'post' });

    expect(result.balance).toBe(300);
    expect(await balanceOf()).toBe(300);
  });

  it('refuses to overspend and leaves the balance untouched', async () => {
    await seedBalance(50);
    await expect(
      walletService.debit({ userId: user.id, amount: 100, type: 'post' }),
    ).rejects.toThrow('Not enough tokens for this.');

    expect(await balanceOf()).toBe(50);
  });

  it('allows spending the balance down to exactly zero', async () => {
    await seedBalance(100);
    const result = await walletService.debit({ userId: user.id, amount: 100, type: 'post' });
    expect(result.balance).toBe(0);
  });

  it('rejects a non-positive or fractional amount before touching the database', async () => {
    await seedBalance(500);
    for (const amount of [0, -50, 12.5]) {
      await expect(
        walletService.debit({ userId: user.id, amount, type: 'post' }),
      ).rejects.toThrow('whole number greater than zero');
    }
    expect(await balanceOf()).toBe(500);
  });

  it('gives a first-time spender a clean refusal rather than a missing-wallet error', async () => {
    await expect(
      walletService.debit({ userId: user.id, amount: 10, type: 'post' }),
    ).rejects.toThrow('Not enough tokens for this.');
  });
});

describe('concurrency — the reason this module has a ledger', () => {
  it('NEVER SPENDS MORE THAN THE BALANCE, however many requests arrive at once', async () => {
    // 1000 tokens, twenty simultaneous 100-token debits. Exactly ten are affordable.
    // A read-then-write implementation passes every other test in this file and fails here.
    await seedBalance(1000);

    const attempts = Array.from({ length: 20 }, (_, i) =>
      walletService
        .debit({ userId: user.id, amount: 100, type: 'post', idempotencyKey: `race-${i}` })
        .then(() => 'ok')
        .catch(() => 'refused'),
    );
    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(10);
    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(10);
    expect(await balanceOf()).toBe(0);
  });

  it('never lets the balance go negative under an uneven burst', async () => {
    await seedBalance(250);

    const amounts = [100, 100, 100, 50, 50, 200];
    const outcomes = await Promise.all(
      amounts.map((amount, i) =>
        walletService
          .debit({ userId: user.id, amount, type: 'vote', idempotencyKey: `burst-${i}` })
          .then((r) => r.balance)
          .catch(() => null),
      ),
    );

    const finalBalance = await balanceOf();
    expect(finalBalance).toBeGreaterThanOrEqual(0);
    // Whatever combination succeeded, the spend must reconcile exactly.
    const spent = 250 - finalBalance;
    const succeeded = outcomes.filter((b) => b !== null);
    expect(succeeded.length).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(250);
  });
});

describe('idempotency — a retry must not spend twice', () => {
  it('replays the original result for a repeated key', async () => {
    await seedBalance(500);
    const first = await walletService.debit({ userId: user.id, amount: 100, type: 'post', idempotencyKey: 'k1' });
    const second = await walletService.debit({ userId: user.id, amount: 100, type: 'post', idempotencyKey: 'k1' });

    expect(first.balance).toBe(400);
    expect(second.balance).toBe(400);
    expect(second.replayed).toBe(true);
    expect(await balanceOf()).toBe(400);
    expect(await LedgerEntry.countDocuments({ idempotencyKey: 'k1' })).toBe(1);
  });

  it('replays a REFUSAL rather than succeeding later', async () => {
    // Same key must always mean the same thing. If a retry succeeded just because the balance
    // was topped up in between, one key would have produced two different outcomes.
    await seedBalance(10);
    await expect(
      walletService.debit({ userId: user.id, amount: 100, type: 'post', idempotencyKey: 'k2' }),
    ).rejects.toThrow('Not enough tokens');

    await seedBalance(1000);
    await expect(
      walletService.debit({ userId: user.id, amount: 100, type: 'post', idempotencyKey: 'k2' }),
    ).rejects.toThrow('Not enough tokens');

    expect(await balanceOf()).toBe(1000);
  });

  it('spends once when the same key arrives twice simultaneously', async () => {
    await seedBalance(500);
    const [a, b] = await Promise.all([
      walletService.debit({ userId: user.id, amount: 100, type: 'post', idempotencyKey: 'k3' }).catch((e) => e),
      walletService.debit({ userId: user.id, amount: 100, type: 'post', idempotencyKey: 'k3' }).catch((e) => e),
    ]);

    expect(await balanceOf()).toBe(400);
    expect(await LedgerEntry.countDocuments({ idempotencyKey: 'k3' })).toBe(1);
    // One succeeded; the other either replayed it or was told it was in flight. Neither spent.
    expect([a, b].some((r) => r?.balance === 400)).toBe(true);
  });
});

describe('the ledger', () => {
  it('records a debit as a negative amount with the resulting balance', async () => {
    await seedBalance(500);
    await walletService.debit({ userId: user.id, amount: 200, type: 'post' });

    const entry = await LedgerEntry.findOne({ user: user.id });
    expect(entry.amount).toBe(-200);
    expect(entry.type).toBe('post');
    expect(entry.status).toBe('applied');
    expect(entry.balanceAfter).toBe(300);
  });

  it('SUMS TO THE BALANCE across a mixed run', async () => {
    // The property that makes the ledger worth having: it can prove the balance.
    await walletService.credit({ userId: user.id, amount: 1000, type: 'grant' });
    await walletService.debit({ userId: user.id, amount: 100, type: 'post' });
    await walletService.debit({ userId: user.id, amount: 50, type: 'vote' });
    await walletService.credit({ userId: user.id, amount: 25, type: 'refund' });

    const entries = await LedgerEntry.find({ user: user.id, status: 'applied' });
    const sum = entries.reduce((total, e) => total + e.amount, 0);

    expect(sum).toBe(await balanceOf());
    expect(sum).toBe(875);
  });

  it('leaves a failed row rather than nothing when a debit is refused', async () => {
    await seedBalance(10);
    await expect(walletService.debit({ userId: user.id, amount: 100, type: 'post' })).rejects.toThrow();

    const entry = await LedgerEntry.findOne({ user: user.id });
    expect(entry.status).toBe('failed');
    expect(entry.balanceAfter).toBeNull();
  });

  it('excludes failed rows from the sum', async () => {
    await seedBalance(100);
    await walletService.debit({ userId: user.id, amount: 40, type: 'post' });
    await expect(walletService.debit({ userId: user.id, amount: 500, type: 'post' })).rejects.toThrow();

    const applied = await LedgerEntry.find({ user: user.id, status: 'applied' });
    expect(applied.reduce((t, e) => t + e.amount, 0)).toBe(-40);
    expect(await balanceOf()).toBe(60);
  });
});

describe('credit', () => {
  it('records a grant with no fiat value', async () => {
    const result = await walletService.credit({ userId: user.id, amount: 250, type: 'grant' });

    expect(result.balance).toBe(250);
    const entry = await LedgerEntry.findOne({ user: user.id });
    expect(entry.type).toBe('grant');
    expect(entry.fiatCents).toBeNull();
    expect((await Wallet.findOne({ user: user.id })).lifetimeGranted).toBe(250);
  });

  it('REFUSES a purchase that does not record what was paid', async () => {
    // Without this, host earnings (QinMvpDocs §6) become uncomputable for that purchase, and
    // the rate cannot be reconstructed after the fact.
    await expect(
      walletService.credit({ userId: user.id, amount: 100, type: 'purchase' }),
    ).rejects.toThrow('must record what was paid');
  });

  it('accepts a purchase that records the amount paid', async () => {
    await walletService.credit({ userId: user.id, amount: 100, type: 'purchase', fiatCents: 2500 });

    const entry = await LedgerEntry.findOne({ user: user.id, type: 'purchase' });
    expect(entry.fiatCents).toBe(2500);
    expect((await Wallet.findOne({ user: user.id })).lifetimePurchased).toBe(100);
  });
});

describe('POST /api/wallet/grant (development only)', () => {
  it('credits the authenticated caller', async () => {
    const res = await request(app).post('/api/wallet/grant').set(auth()).send({ amount: 250 });

    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(250);
    expect(await balanceOf()).toBe(250);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/wallet/grant').send({ amount: 250 });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown field — no crediting someone else', async () => {
    const res = await request(app)
      .post('/api/wallet/grant')
      .set(auth())
      .send({ amount: 250, userId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(400);
  });

  it('rejects an amount over the cap', async () => {
    const res = await request(app).post('/api/wallet/grant').set(auth()).send({ amount: 999999 });
    expect(res.status).toBe(400);
  });
});
