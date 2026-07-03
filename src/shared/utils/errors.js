/**
 * errors.js — a small custom error type for the whole app.
 *
 * WHY: when something goes wrong in a service (e.g. "email already registered"),
 * we want to say BOTH what happened (message) AND which HTTP status it maps to
 * (409). A plain `throw new Error('...')` can't carry the status code. AppError
 * does, so the central error handler can turn any thrown AppError straight into
 * the correct HTTP response — no if/else chains scattered around.
 */

class AppError extends Error {
  /**
   * @param {number} statusCode - HTTP status to send (e.g. 400, 409).
   * @param {string} message    - Human-readable message safe to show the user.
   */
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    // Marks this as an EXPECTED error we threw on purpose (bad input, duplicate,
    // etc.), as opposed to an unexpected bug. The error handler uses this to
    // decide whether to leak the message or hide it behind a generic 500.
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
