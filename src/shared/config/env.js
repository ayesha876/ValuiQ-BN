/**
 * env.js — the ONE place that reads process.env.
 *
 * WHY: instead of sprinkling `process.env.X` all over the codebase (easy to
 * typo, hard to see what the app actually needs), every environment variable is
 * read here once, given a sensible default where safe, and exported as a plain
 * `config` object. The rest of the app imports `config`, never `process.env`.
 *
 * This keeps secrets out of the code (they live in .env) and makes the full list
 * of required configuration obvious to any new developer.
 */

// Load variables from a local .env file into process.env (dev only; in real
// deployments the host provides these directly). Safe to call once, at startup.
require('dotenv').config({ quiet: true });

const nodeEnv = process.env.NODE_ENV || 'development';

/**
 * Returns the first name that is actually set to a non-empty value.
 *
 * Several variables have two accepted names: the one the hosting platforms are
 * configured with (MONGODB_URI, FRONTEND_URL, SMTP_*) and the one this codebase
 * and every existing local .env already use (MONGO_URI, CLIENT_URL, EMAIL_*).
 * Accepting both means a deploy and a laptop can disagree about the name without
 * either one breaking, and the test suites keep running untouched.
 *
 * The platform name is listed FIRST at every call site, so it wins where both exist.
 *
 * @param {...string} names Env var names, most-preferred first.
 * @returns {string|undefined} The first non-empty value, or undefined if none are set.
 */
function pickEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

const config = {
  // --- Server ---
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: Number(process.env.PORT) || 5000,

  // The interface to bind. Render (and most container hosts) route traffic to the
  // container's external interface, so a server bound to loopback is unreachable and
  // the deploy fails its health check with no error in the logs. 0.0.0.0 is the only
  // safe default there; HOST stays overridable for anyone who needs to narrow it.
  host: process.env.HOST || '0.0.0.0',

  // --- Database ---
  // No default on purpose: a wrong/placeholder DB URI silently connecting to the
  // wrong place is worse than failing loudly. server.js checks this is present.
  mongoUri: pickEnv('MONGODB_URI', 'MONGO_URI'),

  mongo: {
    // Atlas M0 clusters idle down, so the first connection after a quiet period can
    // take several seconds. Mongoose's 30s driver default is fine, but being explicit
    // documents the intent and keeps a genuinely unreachable cluster from hanging a
    // cold start for the full default.
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 15_000,
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45_000,

    // M0 allows 500 connections cluster-wide. A small pool leaves room for the shell,
    // Compass, and a second instance during a rolling deploy.
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 10,

    // How many times to retry the INITIAL connect before giving up and exiting. A free
    // instance and a sleeping M0 waking at the same time is the common case this covers.
    connectRetries: Number(process.env.MONGO_CONNECT_RETRIES) || 3,
    connectRetryDelayMs: Number(process.env.MONGO_CONNECT_RETRY_DELAY_MS) || 2_000,
  },

  // OPTIONAL. Some networks' default DNS refuse the SRV lookup that a
  // `mongodb+srv://` URI needs. If set (comma-separated, e.g. "8.8.8.8,1.1.1.1"),
  // we point Node's resolver at these public DNS servers so Atlas resolves.
  // Leave empty in production/normal networks — it stays a no-op.
  dnsServers: process.env.DNS_SERVERS,

  // --- Security ---
  // bcrypt cost factor. 10 is a good balance of security vs. speed for ~1000s of
  // users. Higher = slower to brute-force but also slower to register.
  bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS) || 10,

  // --- OTP / email verification ---
  // How long a registration OTP stays valid, in minutes.
  otpExpiryMinutes: Number(process.env.OTP_EXPIRY_MINUTES) || 10,

  // How long a PASSWORD-RESET OTP stays valid, in minutes. Kept separate from the
  // registration OTP timing so the two flows can be tuned independently.
  resetOtpExpiryMinutes: Number(process.env.RESET_OTP_EXPIRY_MINUTES) || 10,

  // --- JWT (login session token) ---
  // The LOGIN token grants full app access. Signed with JWT_SECRET; JWT_EXPIRES_IN
  // controls how long a session lasts (e.g. "7d", "12h"). No default secret on
  // purpose — a hardcoded fallback secret would be a real security hole.
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // --- Reset token (password-reset ONLY) ---
  // A DELIBERATELY SEPARATE secret + short expiry from the login JWT. Using a
  // different secret means a reset token can never be verified as a login token
  // (or vice-versa), even by accident. It also carries a `purpose: 'reset'` claim
  // as a second layer of protection. See generateToken.js.
  resetToken: {
    secret: process.env.RESET_TOKEN_SECRET,
    expiresIn: process.env.RESET_TOKEN_EXPIRES_IN || '15m',
  },

  // --- Email (SMTP fallback). All optional in dev: if host is missing we fall back to a
  // Nodemailer "Ethereal" test inbox and always log the OTP to the console. ---
  email: {
    host: pickEnv('SMTP_HOST', 'EMAIL_HOST'),
    port: Number(pickEnv('SMTP_PORT', 'EMAIL_PORT')) || 587,
    user: pickEnv('SMTP_USER', 'EMAIL_USER'),
    pass: pickEnv('SMTP_PASS', 'EMAIL_PASS'),
    from: pickEnv('SMTP_FROM', 'EMAIL_FROM') || 'ValuiQ <no-reply@valuiq.com>',
  },

  // --- Email (Resend, the primary transport) ---
  // Unset means "no Resend", which is a supported way to run: sendEmail() then goes
  // straight to SMTP, and failing that to Ethereal in dev. Same optional-dependency
  // shape as Redis below — a missing key degrades the transport, it does not break send.
  resend: {
    apiKey: process.env.RESEND_API_KEY,
  },

  // --- Redis (Week 4: fairness timers + cross-instance pub/sub) ---
  // NO DEFAULT, ON PURPOSE. Unset means "no Redis", which is a supported way to run this app:
  // timers fall back to the database sweep and pub/sub falls back to in-process emit. A
  // default of localhost:6379 would turn a missing config into a connection error storm on
  // every machine that does not happen to be running Redis.
  //
  // In production this is an Upstash `rediss://` TCP URL, NOT the REST endpoint. BullMQ's
  // blocking commands and the pub/sub in shared/events/bus.js both need a real socket;
  // the Upstash REST API is request/response only and can serve neither. Upstash exposes
  // both on the same free database — take the one labelled for redis-cli/ioredis.
  redisUrl: pickEnv('REDIS_URL', 'UPSTASH_REDIS_URL'),

  // --- Fairness timer (Week 4 moderation) ---
  fairness: {
    // How long a post waits for a moderator before it is auto-neglected and everyone who
    // staked on it is refunded.
    //
    // The DEADLINE ITSELF IS NOT HERE. It comes from the event's (or the round's)
    // `neglectTimer`, in seconds, which the host sets per stage on the Create Event form and
    // which is shown to attendees as an accountability commitment. A global timeout would
    // silently override every host who configured one. This value is only the fallback for a
    // stage that left it blank.
    defaultTimerSeconds: Number(process.env.FAIRNESS_DEFAULT_TIMER_SECONDS) || 300,

    // Ceiling on a host-configured timer. A host who types 999999 should not be able to pin
    // an attendee's tokens for eleven days.
    maxTimerSeconds: Number(process.env.FAIRNESS_MAX_TIMER_SECONDS) || 86_400,

    // When to warn the control room that a post is about to time out, as a FRACTION of the
    // post's own timer rather than a fixed lead time. The brief asked for "1 hour before",
    // which cannot work here: neglect timers are seconds, commonly 30-300, so a fixed hour
    // would fire before the post was even submitted. 0.8 = warn with 20% of the clock left.
    warnAtElapsedFraction: Number(process.env.FAIRNESS_WARN_FRACTION) || 0.8,

    // How often the safety-net sweep looks for overdue posts the queue never fired for.
    // Independent of Redis — this is what makes auto-neglect inevitable rather than merely
    // punctual. See fairnessTimer.worker.js.
    sweepIntervalSeconds: Number(process.env.FAIRNESS_SWEEP_INTERVAL_SECONDS) || 60,
  },

  // --- Client (CORS allowlist + links in emails) ---
  // May be a single origin or a comma-separated list. The localhost default is a DEV
  // convenience only — app.js refuses to fall back to it in production, because an API
  // that silently trusts localhost in prod is an allowlist that isn't one.
  clientUrl: pickEnv('FRONTEND_URL', 'CLIENT_URL') || 'http://localhost:5173',
};

module.exports = config;
