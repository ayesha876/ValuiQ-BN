import fs from 'node:fs';
import { defineConfig } from 'vitest/config';

// Test-only environment. The integration suite drives the real Express app against an
// in-memory MongoDB (mongodb-memory-server), so config/env must have the values app.js
// and the JWT/mailer layers read at load time. EMAIL_* point at a dead local SMTP so the
// moderator-bridge's best-effort send fails FAST (and is swallowed in non-prod) instead of
// reaching for an Ethereal test account over the network.

/**
 * Use a locally-installed mongod if there is one.
 *
 * mongodb-memory-server otherwise downloads its own ~600MB MongoDB on first run. On a slow or
 * interrupted connection that download never completes, and EVERY integration test then fails
 * in beforeAll with an opaque timeout that looks like a broken test rather than a missing
 * binary — which is exactly what was happening on this machine.
 *
 * Reusing an installed server makes the suite start in about a second. Each of the paths below
 * is checked only if it exists, and an explicit MONGOMS_SYSTEM_BINARY always wins, so on CI or
 * a machine without MongoDB this is a no-op and the normal download path still applies.
 */
function findSystemMongod() {
  if (process.env.MONGOMS_SYSTEM_BINARY) return process.env.MONGOMS_SYSTEM_BINARY;

  const candidates = [
    ...[ '8.2', '8.0', '7.0', '6.0' ].map((v) => `C:\\Program Files\\MongoDB\\Server\\${v}\\bin\\mongod.exe`),
    '/usr/bin/mongod',
    '/usr/local/bin/mongod',
    '/opt/homebrew/bin/mongod',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const systemMongod = findSystemMongod();

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret',
      RESET_TOKEN_SECRET: 'test-reset-secret',
      CLIENT_URL: 'http://localhost:5173',
      MONGO_URI: 'mongodb://127.0.0.1:27017/placeholder',
      EMAIL_HOST: '127.0.0.1',
      EMAIL_PORT: '1025',
      EMAIL_USER: 'test',
      EMAIL_PASS: 'test',
      EMAIL_FROM: 'test@valuiq.local',
      // Only set when a local mongod was actually found — an empty string here would be a
      // path mongodb-memory-server might try to execute rather than a clean "not configured".
      ...(systemMongod ? { MONGOMS_SYSTEM_BINARY: systemMongod } : {}),
    },
    testTimeout: 30000,
    hookTimeout: 120000, // first mongodb-memory-server boot can be slow
  },
});
