/**
 * event.routes.js — the event endpoints and the middleware pipeline each runs.
 *
 * Pipeline order (per protected route):
 *   rateLimiter -> authMiddleware -> requireRole -> [zodValidate] -> controller
 *
 * Throttle first (cheaply shed floods before touching JWT/DB), then prove WHO the
 * caller is (auth), then WHAT they're allowed to do (role), then validate the body,
 * then run the thin controller. All event routes are Event-Organizer-only.
 */
const express = require('express');

const authMiddleware = require('../../shared/middlewares/auth.middleware');
const requireRole = require('../../shared/middlewares/rbac.middleware');
const rateLimiter = require('../../shared/middlewares/rateLimiter.middleware');
const zodValidate = require('../../shared/middlewares/zodValidate.middleware');
const controller = require('./event.controller');
const { createEventSchema, updateEventSchema, listEventsQuerySchema } = require('./event.validation');

const router = express.Router();

// Cap event creation per IP so the endpoint can't be spammed (creating rows +
// generating slugs). Generous enough to be invisible to a real organizer.
const createLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many events created. Please try again in a few minutes.',
});

// Every event route requires a signed-in Event Organizer.
router.use(authMiddleware, requireRole('Event Organizer'));

// POST /api/events  — create (Save Draft or Go Live, via `intent`)
router.post('/', createLimiter, zodValidate(createEventSchema), controller.create);

// GET /api/events  — list own events (paginated + optional search/status filter)
router.get('/', zodValidate(listEventsQuerySchema, 'query'), controller.list);

// GET /api/events/:id  — single event (ownership enforced in the service)
router.get('/:id', controller.getOne);

// PATCH /api/events/:id  — partial update (ownership enforced in the service)
router.patch('/:id', zodValidate(updateEventSchema), controller.update);

// DELETE /api/events/:id  — soft delete (ownership + state enforced in the service)
router.delete('/:id', controller.remove);

module.exports = router;
