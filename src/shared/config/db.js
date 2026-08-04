/**
 * db.js — MongoDB (Atlas) connection.
 *
 * WHY a dedicated file: connecting to the database is a startup concern, not a
 * request concern. Keeping it here means server.js just calls connectDB() and
 * doesn't need to know about Mongoose details.
 */
const dns = require('dns');
const mongoose = require('mongoose');
const config = require('./env');

/**
 * Opens the single shared Mongoose connection used by the whole app.
 *
 * If MONGO_URI is not set we STOP the process with a clear instruction, because
 * running an API with no database is never what you want — failing loudly here
 * saves hours of confusing "why is my data not saving" debugging later.
 */
async function connectDB() {
  if (!config.mongoUri) {
    console.error(
      '\n[ValuiQ] MONGODB_URI is missing.\n' +
        'Add this line to your .env file (copy .env.example to .env first):\n' +
        '  MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/valuiq?retryWrites=true&w=majority\n' +
        '(The older name MONGO_URI is still accepted.)\n',
    );
    process.exit(1);
  }

  // Work around networks whose default DNS refuses Atlas SRV lookups (optional,
  // only when DNS_SERVERS is set). No-op on normal networks / in production.
  if (config.dnsServers) {
    dns.setServers(config.dnsServers.split(',').map((s) => s.trim()));
    console.log('Using custom DNS servers for Atlas lookup:', config.dnsServers);
  }

  // RETRY THE FIRST CONNECT, don't just fail the boot.
  //
  // Once connected, the driver reconnects on its own — this loop only covers the
  // opening handshake, which is exactly where a free-tier deploy is fragile: a shared
  // instance and a paused Atlas M0 often wake at the same moment, and the cluster can
  // refuse selection for a few seconds while it comes up. Exiting on the first refusal
  // turns a normal cold start into a crash loop, and on a host that redeploys on crash
  // that loop is indistinguishable from a bad connection string.
  //
  // Bounded on purpose: a genuinely wrong URI or a blocked IP must still fail loudly
  // and quickly rather than retrying forever behind a "starting…" spinner.
  const { connectRetries, connectRetryDelayMs, ...clientOptions } = config.mongo;

  for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
    try {
      await mongoose.connect(config.mongoUri, clientOptions);
      console.log('MongoDB connected');
      return;
    } catch (err) {
      const isLastAttempt = attempt === connectRetries;
      if (isLastAttempt) {
        console.error(
          `\n[ValuiQ] Could not reach MongoDB after ${connectRetries} attempts: ${err.message}\n` +
            'Check MONGODB_URI, the database user password, and that your deployment IP is\n' +
            'allowed under Atlas > Network Access.\n',
        );
        process.exit(1);
      }

      // Linear backoff. The failure this covers resolves in seconds, so spacing attempts
      // further apart would only delay a boot that was about to succeed.
      const waitMs = connectRetryDelayMs * attempt;
      console.warn(
        `[db] Connection attempt ${attempt}/${connectRetries} failed (${err.message}). ` +
          `Retrying in ${waitMs}ms…`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

module.exports = connectDB;
