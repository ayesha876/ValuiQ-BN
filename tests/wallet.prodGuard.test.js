/**
 * wallet.prodGuard.test.js — proves the dev token grant does not exist in production.
 *
 * This is a separate file because it has to set NODE_ENV BEFORE app.js is imported: the mount
 * is decided once, at import time. Vitest isolates module registries per file, so this cannot
 * affect the other suites.
 *
 * Worth its own file for what it protects. The grant endpoint creates currency from nothing;
 * if it ever shipped enabled, anyone with an account could mint an unlimited balance. The
 * guard is one `if` in app.js and one in the router, and both are one careless edit from
 * disappearing — so the assertion lives here permanently rather than in someone's memory.
 *
 * No database is needed: a route that was never mounted 404s long before anything is queried.
 */
import request from 'supertest';
import { beforeAll, describe, it, expect } from 'vitest';

let app;

beforeAll(async () => {
  // Must be set before the import below — app.js reads it while building the route table.
  process.env.NODE_ENV = 'production';
  app = (await import('../app.js')).default;
});

describe('the dev token grant in production', () => {
  it('DOES NOT EXIST — the route is never mounted', async () => {
    const res = await request(app).post('/api/wallet/grant').send({ amount: 100 });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    // Indistinguishable from any other unknown path: the endpoint does not advertise itself.
    expect(res.body.message).toMatch(/Route not found/);
  });

  it('is not reachable with a body that would otherwise be valid', async () => {
    const res = await request(app).post('/api/wallet/grant').send({ amount: 1 });
    expect(res.status).toBe(404);
  });
});
