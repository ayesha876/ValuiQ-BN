/**
 * rateLimiter.middleware.js — a per-IP request limiter built on `express-rate-limit`.
 *
 * WHY: the login route lets anyone submit an email + password. Without a limit,
 * an attacker could fire thousands of guesses per minute (a brute-force attack).
 * This middleware caps how many times one IP address may hit a route inside a
 * time window; once over the cap it answers 429 (Too Many Requests) instead of
 * running the handler.
 *
 * We wrap `express-rate-limit` (the battle-tested standard) behind our own small
 * factory so callers stay decoupled from the library: routes just call
 * `rateLimiter({ windowMs, max, message })`. If we ever move the counters to a
 * shared store (e.g. Redis, so limits hold across restarts and multiple server
 * instances), we add a `store` here — no route changes needed.
 *
 * NOTE: the default store is in-memory, which is fine for a single process. For a
 * multi-instance production deploy, plug in `rate-limit-redis` using the project's
 * existing ioredis/REDIS_URL and pass it as `store` below.
 */
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * What counts as "one caller".
 *
 * PER USER when the request is authenticated, per IP otherwise.
 *
 * Per-IP alone is actively wrong for this product: at a live event the entire audience is
 * behind the venue's wifi, so hundreds of attendees share one NAT address. A per-IP cap would
 * throttle the whole room as though it were a single person hammering the API — and the more
 * successful the event, the harder it would break.
 *
 * Unauthenticated routes (login, register, forgot-password) still key by IP, which is correct:
 * there is no user yet, and brute-forcing credentials IS an per-origin attack.
 *
 * `ipKeyGenerator` rather than `req.ip` directly — it normalises IPv6 addresses to a subnet so
 * a single client cannot trivially rotate through its own /64.
 */
function callerKey(req, res) {
  return req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req, res);
}

/**
 * Build a rate-limiting middleware.
 * @param {object} [options]
 * @param {number} [options.windowMs=900000]  Length of the window in ms (default 15 min).
 * @param {number} [options.max=10]            Max allowed requests per IP per window.
 * @param {string} [options.message]           Message sent on the 429 response.
 * @returns {import('express').RequestHandler}
 */
function rateLimiter({
  windowMs = 15 * 60 * 1000, // 15 minutes
  max = 10, // allow 10 attempts per window per IP
  message = 'Too many requests. Please try again later.',
} = {}) {
  return rateLimit({
    windowMs,
    limit: max, // requests allowed per caller per window before 429s begin
    // Per authenticated user where possible, per IP otherwise — see callerKey above.
    keyGenerator: callerKey,
    // Send the modern, standard `RateLimit-*` headers; drop the legacy `X-*` ones.
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Respond in OUR envelope shape so the frontend's error handling
    // (`err.response.data.message`) works exactly as it does everywhere else.
    handler: (req, res) => {
      res.status(429).json({ success: false, message });
    },
  });
}

module.exports = rateLimiter;
