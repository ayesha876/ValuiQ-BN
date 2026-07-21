import { defineConfig } from 'vitest/config';

// Test-only environment. The integration suite drives the real Express app against an
// in-memory MongoDB (mongodb-memory-server), so config/env must have the values app.js
// and the JWT/mailer layers read at load time. EMAIL_* point at a dead local SMTP so the
// moderator-bridge's best-effort send fails FAST (and is swallowed in non-prod) instead of
// reaching for an Ethereal test account over the network.
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
    },
    testTimeout: 30000,
    hookTimeout: 120000, // first mongodb-memory-server boot can be slow
  },
});
