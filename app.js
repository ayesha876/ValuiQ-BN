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
const eventRoutes = require('./src/modules/events/event.routes');
const { arenaRoutes, feedRoutes, postRoutes } = require('./src/modules/posts/post.routes');
const voteRoutes = require('./src/modules/votes/vote.routes');
const moderationRoutes = require('./src/modules/moderation/moderation.routes');
const queueRoutes = require('./src/modules/queue/queue.routes');
const revenueRoutes = require('./src/modules/revenue/revenue.routes');
const {
  eventModeratorRoutes,
  moderatorRoutes,
} = require('./src/modules/moderators/moderator.routes');
const moderatorDashboardRoutes = require('./src/modules/moderators/dashboard.routes');
const attendeeRoutes = require('./src/modules/attendee/attendee.routes');
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

// Parse incoming JSON bodies into req.body. The size cap is a cheap DoS guard —
// event/auth payloads are small JSON, so 16kb is generous but bounds abuse.
app.use(express.json({ limit: '16kb' }));

// Concise request logs — dev only, to keep production logs clean.
if (!config.isProduction) app.use(morgan('dev'));

// Simple health check so you can confirm the server is up during testing.
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'ValuiQ API is running.' });
});

// Auth feature routes (register / verify-email / resend-otp / set-password).
app.use('/api/auth', authRoutes);

// Moderator invite/accept. The event-scoped router is mounted BEFORE /api/events so
// the events router's auth/role middleware doesn't pre-run on /moderators paths. It
// can't shadow event CRUD — it requires the literal `/moderators` segment after the id.
app.use('/api/events/:eventId/moderators', eventModeratorRoutes);

// Attendee + moderator post routes. Mounted BEFORE /api/events for the same reason as the
// moderator router above: the events router applies requireRole('Event Organizer') to
// everything under it, and attendees are not organizers. Both require a literal path segment
// after the id, so neither can shadow event CRUD.
app.use('/api/events/:eventId/arena', arenaRoutes);
app.use('/api/events/:eventId/feed', feedRoutes);
// Week 4 moderation. Event-scoped for the same reason as the moderator router: authorization
// here is per-event, so the guard needs the event in the path and must run before any post is
// read. Both require a literal segment after the id, so neither shadows event CRUD.
app.use('/api/events/:eventId/moderation', moderationRoutes);
app.use('/api/events/:eventId/queue', queueRoutes);
// Most specific first: votes live under a post, so this is declared before the posts router.
app.use('/api/events/:eventId/posts/:postId/votes', voteRoutes);
app.use('/api/events/:eventId/posts', postRoutes);

// Event Management routes (create / list / get / update).
app.use('/api/events', eventRoutes);

// Standalone moderator routes (accept).
app.use('/api/moderators', moderatorRoutes);

// The caller's OWN view of the platform. Neither is event-scoped: they answer "what is mine",
// so the resource is the signed-in user and no id appears in either path.
//
// `/api/moderator` (singular) is the moderator's landing data — deliberately distinct from
// `/api/moderators` (plural) above, which manages one event's roster. It also serves as the
// capability check: a non-empty list is what tells the frontend this user moderates anything at
// all, because there is no global flag that can answer that.
app.use('/api/attendee', attendeeRoutes);
app.use('/api/moderator', moderatorDashboardRoutes);

// Host earnings. NOT event-scoped: earnings belong to a host across every event they run, so
// the host is the resource. Ownership is checked in the controller against the token.
app.use('/api/revenue', revenueRoutes);

// ⚠️ DEVELOPMENT-ONLY. The token grant exists so posting and voting can be exercised before
// Stripe purchases land in Week 5. This is the FIRST conditional mount in this file, and the
// condition is the point: in production the router is never attached, so /api/wallet/grant
// falls through to the 404 below. The router carries its own production guard as well —
// see wallet.routes.js for why one guard was not considered enough for an endpoint that
// creates currency out of nothing.
if (!config.isProduction) {
  // eslint-disable-next-line global-require
  app.use('/api/wallet', require('./src/modules/wallet/wallet.routes'));
  console.warn('[wallet] Dev token grant mounted at POST /api/wallet/grant (non-production only).');
}

// Anything that reached here matched no route above -> 404 through our handler.
app.use((req, res, next) => {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
});

// Central error handler — must be registered LAST.
app.use(errorHandler);

module.exports = app;
