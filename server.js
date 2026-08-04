/**
 * server.js — the entry point. It connects to MongoDB FIRST, then starts the
 * HTTP server. Connecting first means we never accept requests we can't serve.
 */
const http = require('node:http');

const config = require('./src/shared/config/env');
const connectDB = require('./src/shared/config/db');
const app = require('./app');
const { initSockets } = require('./src/sockets/socket');
const { startFairnessTimer } = require('./src/jobs/workers/fairnessTimer.worker');

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

  // Socket.IO needs the underlying HTTP server to attach to, which app.listen() creates but
  // never hands back. Creating it explicitly lets REST and realtime share one port and one
  // process. `app` itself is untouched, so every existing test still exercises the same app.
  const httpServer = http.createServer(app);
  initSockets(httpServer);

  // The fairness mechanism: the BullMQ worker (punctual, needs Redis) and the database sweep
  // (inevitable, needs nothing). Started AFTER the DB connection above, because the sweep's
  // first pass runs immediately and needs somewhere to read from.
  //
  // Run in-process with the API for now. Both halves are safe to run anywhere — settlement is
  // claimed through a unique index, so N instances still refund each post exactly once — so
  // splitting the worker into its own process later is a deployment change, not a code one.
  const { worker } = startFairnessTimer();

  httpServer.listen(config.port, () => {
    console.log(`ValuiQ API listening on http://localhost:${config.port} [${config.nodeEnv}]`);
    console.log(`ValuiQ realtime attached on the same port (rooms: event:<id>, event:<id>:control)`);
    console.log(
      worker
        ? '[fairness] Timer worker + sweep running.'
        : '[fairness] No REDIS_URL — auto-neglect runs on the database sweep alone.',
    );
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
