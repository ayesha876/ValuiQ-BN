/**
 * server.js — the entry point. It connects to MongoDB FIRST, then starts the
 * HTTP server. Connecting first means we never accept requests we can't serve.
 */
const config = require('./src/shared/config/env');
const connectDB = require('./src/shared/config/db');
const app = require('./app');

// Refuse to boot if a critical secret is missing — failing loudly here beats
// signing/verifying tokens with `undefined` and getting silent auth failures.
function assertRequiredConfig() {
  const missing = [];
  if (!config.jwt.secret) missing.push('JWT_SECRET');
  if (missing.length) {
    console.error(
      `\n[ValuiQ] Missing required env: ${missing.join(', ')}.\n` +
        'Set it in your .env file before starting.\n',
    );
    process.exit(1);
  }
}

async function start() {
  assertRequiredConfig(); // refuse to boot without critical secrets
  await connectDB(); // exits with a clear message if MONGO_URI is missing/bad
  app.listen(config.port, () => {
    console.log(`ValuiQ API listening on http://localhost:${config.port} [${config.nodeEnv}]`);
  });
}

start().catch((err) => {
  console.error('[startup] Failed to start server:', err.message);
  process.exit(1);
});

// Safety nets: never let an unhandled async error silently corrupt state.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
