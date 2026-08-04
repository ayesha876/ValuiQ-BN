/**
 * auth.middleware.js — proves WHO is making the request.
 *
 * It reads the login token from the `Authorization: Bearer <token>` header,
 * verifies it, and attaches a minimal `req.user = { id, role }` for downstream
 * middleware/controllers. Any problem (no header, wrong format, bad/expired token)
 * ends the request with a 401 through the central error handler — protected routes
 * never run without a proven identity.
 */
const AppError = require('../utils/errors');
const { verifyLoginToken } = require('../utils/generateToken');

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';

  // Must be exactly "Bearer <token>". Anything else = not authenticated.
  if (!header.startsWith('Bearer ')) {
    return next(new AppError(401, 'Authentication required. Please log in.'));
  }

  const token = header.slice(7).trim();
  if (!token) {
    return next(new AppError(401, 'Authentication required. Please log in.'));
  }

  // Verify the token in ISOLATION. Any failure here means the caller isn't
  // authenticated — expired, bad signature, malformed, OR a structurally-valid
  // token whose payload won't parse (jwt.verify throws a SyntaxError). A bad token
  // is ALWAYS a client error (401), never a 500. Only this one call is wrapped, so
  // a genuine server error elsewhere in the middleware still surfaces as a 500.
  let payload;
  try {
    payload = verifyLoginToken(token);
  } catch (err) {
    // An expired token gets a clearer message; every other verify failure is a
    // generic "invalid token". Both are 401.
    const message =
      err.name === 'TokenExpiredError'
        ? 'Your session has expired. Please log in again.'
        : 'Invalid authentication token.';
    return next(new AppError(401, message));
  }

  // Minimal identity only — never the whole user. `sub` is the user id, `role`
  // is what requireRole checks. Loading the fresh user from the DB (to catch a
  // deleted account or a changed role mid-session) is a deliberate Phase-2 item.
  req.user = { id: payload.sub, role: payload.role };
  return next();
}

module.exports = authMiddleware;
