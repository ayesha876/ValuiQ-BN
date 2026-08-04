/**
 * corsOrigins.js — the ONE place that decides which browser origins may call this API.
 *
 * Both entry points need this list: the REST app (app.js) and the Socket.IO server
 * (src/sockets/socket.js). They used to derive it separately from the same variable,
 * which worked right up until one of them gained a rule the other did not — exactly
 * what happened when production stopped trusting localhost.
 */
const config = require('./env');

// Matches an origin whose host is the local machine, with or without a port.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * The allowlist, parsed from FRONTEND_URL (or the legacy CLIENT_URL).
 *
 * In production every localhost origin is dropped. `config.clientUrl` falls back to
 * `http://localhost:5173` so `npm run dev` works with no .env at all — convenient
 * locally, and a hole if it ever shipped: a deployed API would trust any developer's
 * machine, and `credentials: true` means that trust carries the caller's session token.
 *
 * Filtering rather than throwing keeps this module importable from tests. The loud
 * check — refuse to boot at all — is in server.js, which knows it is a real deployment.
 *
 * @returns {string[]} Allowed origins, in the order they were configured.
 */
function getAllowedOrigins() {
  const origins = config.clientUrl
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, '')) // a trailing slash never matches an Origin header
    .filter(Boolean);

  if (!config.isProduction) return origins;
  return origins.filter((origin) => !LOCAL_ORIGIN.test(origin));
}

module.exports = { getAllowedOrigins, LOCAL_ORIGIN };
