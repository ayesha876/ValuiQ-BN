/**
 * app.js — builds and configures the Express application (middleware + routes).
 *
 * It does NOT start listening or connect to the DB — that's server.js. Keeping
 * the app separate from the server makes it easy to import for tests later.
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const config = require('./src/shared/config/env');
const authRoutes = require('./src/modules/auth/auth.routes');
const errorHandler = require('./src/shared/middlewares/errorHandler.middleware');
const AppError = require('./src/shared/utils/errors');

const app = express();

// Security-related HTTP headers (sane defaults).
app.use(helmet());

// Let the frontend call this API from the browser. CLIENT_URL may be a single
// origin or a comma-separated list (e.g. the Vite dev server on :5173 and its
// automatic :5174 fallback, plus a staging URL later). Requests with no Origin
// header (curl, Postman, server-to-server, health checks) are allowed through.
// `credentials: true` permits cookies/Authorization headers on cross-origin
// calls — and requires an explicit origin (never '*'), which the allowlist gives.
const allowedOrigins = config.clientUrl
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  }),
);

// Parse incoming JSON bodies into req.body.
app.use(express.json());

// Concise request logs — dev only, to keep production logs clean.
if (!config.isProduction) app.use(morgan('dev'));

// Simple health check so you can confirm the server is up during testing.
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'ValuiQ API is running.' });
});

// Auth feature routes (register / verify-email / resend-otp / set-password).
app.use('/api/auth', authRoutes);

// Anything that reached here matched no route above -> 404 through our handler.
app.use((req, res, next) => {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
});

// Central error handler — must be registered LAST.
app.use(errorHandler);

module.exports = app;
