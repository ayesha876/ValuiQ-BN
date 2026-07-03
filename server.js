/**
 * server.js — the entry point. It connects to MongoDB FIRST, then starts the
 * HTTP server. Connecting first means we never accept requests we can't serve.
 */
const config = require('./src/shared/config/env');
const connectDB = require('./src/shared/config/db');
const app = require('./app');

async function start() {
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
