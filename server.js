/**
 * server.js — the entry point. It connects to MongoDB FIRST, then starts the
 * HTTP server. Connecting first means we never accept requests we can't serve.
 */
const http = require('node:http');

const config = require('./src/shared/config/env');
const connectDB = require('./src/shared/config/db');
const { getAllowedOrigins } = require('./src/shared/config/corsOrigins');
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

  // PRODUCTION ONLY: a real deployment must know its frontend origin.
  //
  // corsOrigins.js already drops localhost in production, so a misconfigured
  // FRONTEND_URL does not open a hole — it closes everything, and every browser call
  // fails CORS. That is safe but almost impossible to diagnose from the frontend, where
  // it reads as a network error. Refusing to start says it once, in the deploy log,
  // where someone is already looking.
  //
  // This lives here rather than in app.js because only server.js knows this is a
  // deployment: app.js is imported by the test suite, which legitimately runs with
  // NODE_ENV=production and no frontend at all.
  if (config.isProduction && getAllowedOrigins().length === 0) {
    console.error(
      '\n[ValuiQ] FRONTEND_URL is missing or only contains localhost origins, and ' +
        'NODE_ENV=production.\n' +
        'Set it to the deployed frontend origin, e.g.\n' +
        '  FRONTEND_URL=https://your-app.vercel.app\n' +
        '(No trailing slash. Comma-separate multiple origins.)\n',
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

  // The host argument is not optional on a container host: Render routes traffic to the
  // container's external interface, and a server listening only on loopback fails its
  // health check while logging a perfectly healthy "listening" line.
  httpServer.listen(config.port, config.host, () => {
    console.log(`ValuiQ API listening on ${config.host}:${config.port} [${config.nodeEnv}]`);
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
