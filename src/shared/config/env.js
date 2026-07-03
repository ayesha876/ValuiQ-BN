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

const config = {
  // --- Server ---
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: Number(process.env.PORT) || 5000,

  // --- Database ---
  // No default on purpose: a wrong/placeholder DB URI silently connecting to the
  // wrong place is worse than failing loudly. server.js checks this is present.
  mongoUri: process.env.MONGO_URI,

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

  // --- Email (SMTP). All optional in dev: if host is missing we fall back to a
  // Nodemailer "Ethereal" test inbox and always log the OTP to the console. ---
  email: {
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
    from: process.env.EMAIL_FROM || 'ValuiQ <no-reply@valuiq.com>',
  },

  // --- Client (used later for CORS / links in emails) ---
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
};

module.exports = config;
