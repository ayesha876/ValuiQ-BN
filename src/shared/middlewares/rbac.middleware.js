/**
 * rbac.middleware.js — role-based access control (the REAL lock).
 *
 * requireRole('Event Organizer') returns a middleware that only lets a request
 * through if the authenticated user's role is in the allowed list. Hiding a button
 * on the frontend is only UX — anyone can call the API directly, so authorization
 * MUST be enforced here on the server.
 *
 * Runs AFTER authMiddleware, which sets req.user. If req.user is missing the routes
 * are misordered — we fail closed with a 401 rather than silently allowing through.
 */
const AppError = require('../utils/errors');

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    // Fail closed: no identity means auth middleware didn't run (or failed).
    if (!req.user || !req.user.role) {
      return next(new AppError(401, 'Authentication required. Please log in.'));
    }
    // Authenticated, but the role isn't permitted for this action.
    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError(403, 'You do not have permission to perform this action.'));
    }
    return next();
  };
}

module.exports = requireRole;
