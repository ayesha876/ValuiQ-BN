/**
 * errorHandler.middleware.js — the ONE place that converts any error into an
 * HTTP response. It is registered LAST in app.js (after all routes).
 *
 * WHY: controllers simply do `catch (err) { next(err) }`. Every error — whether
 * we threw it on purpose (AppError) or it came from Mongoose — lands here and is
 * translated into a consistent `{ success:false, message }` body with the right
 * status code. One place to reason about error output; no duplication.
 */
const AppError = require('../utils/errors');
const config = require('../config/env');

// eslint-disable-next-line no-unused-vars  (Express needs the 4-arg signature)
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Something went wrong.';

  // --- Translate common Mongoose errors into friendly messages ---

  // Duplicate key: the unique index on `email` rejected a second signup for an
  // email that (due to a race) slipped past our service-level check. 11000 is
  // Mongo's duplicate-key code. We answer 409 with the same wording the service
  // uses, so the client sees one consistent "already registered" message.
  if (err.code === 11000) {
    statusCode = 409;
    message = 'Email already registered.';
  }

  // Schema validation (e.g. role not in the enum) → 400 with the first reason.
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)[0]?.message || 'Invalid input.';
  }

  // Malformed ObjectId etc. → 400 rather than a scary 500.
  if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid value provided.';
  }

  // Log the full error server-side (with stack in dev) for debugging. We never
  // send the stack to the client — that could leak internals.
  if (!(err instanceof AppError) || statusCode >= 500) {
    console.error('[error]', err);
  }

  // Hide details of truly unexpected 500s from the client in production.
  if (statusCode >= 500 && config.isProduction) {
    message = 'Something went wrong. Please try again.';
  }

  res.status(statusCode).json({ success: false, message });
}

module.exports = errorHandler;
