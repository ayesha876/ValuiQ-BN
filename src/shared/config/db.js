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
      '\n[ValuiQ] MONGO_URI is missing.\n' +
        'Add this line to your .env file (copy .env.example to .env first):\n' +
        '  MONGO_URI=mongodb+srv://<user>:<password>@<cluster>/valuiq?retryWrites=true&w=majority\n',
    );
    process.exit(1);
  }

  // Work around networks whose default DNS refuses Atlas SRV lookups (optional,
  // only when DNS_SERVERS is set). No-op on normal networks / in production.
  if (config.dnsServers) {
    dns.setServers(config.dnsServers.split(',').map((s) => s.trim()));
    console.log('Using custom DNS servers for Atlas lookup:', config.dnsServers);
  }

  // Mongoose 8+/9 needs no extra options object for a basic Atlas connection.
  await mongoose.connect(config.mongoUri);
  console.log('MongoDB connected');
}

module.exports = connectDB;
