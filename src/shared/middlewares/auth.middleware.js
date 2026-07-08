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
  try {
    const header = req.headers.authorization || '';

    // Must be exactly "Bearer <token>". Anything else = not authenticated.
    if (!header.startsWith('Bearer ')) {
      throw new AppError(401, 'Authentication required. Please log in.');
    }

    const token = header.slice(7).trim();
    if (!token) {
      throw new AppError(401, 'Authentication required. Please log in.');
    }

    // Genuine + unexpired? verifyLoginToken throws otherwise.
    const payload = verifyLoginToken(token);

    // Minimal identity only — never the whole user. `sub` is the user id, `role`
    // is what requireRole checks. Loading the fresh user from the DB (to catch a
    // deleted account or a changed role mid-session) is a deliberate Phase-2 item.
    req.user = { id: payload.sub, role: payload.role };
    return next();
  } catch (err) {
    // An expired token gets a clearer message; both are 401.
    if (err.name === 'TokenExpiredError') {
      return next(new AppError(401, 'Your session has expired. Please log in again.'));
    }
    if (err.name === 'JsonWebTokenError') {
      return next(new AppError(401, 'Invalid authentication token.'));
    }
    return next(err); // our own AppError(401)s and anything unexpected
  }
}

module.exports = authMiddleware;
