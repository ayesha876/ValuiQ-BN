/**
 * event.controller.js — the thin HTTP layer for events.
 *
 * A controller's ONLY jobs: read what it needs from the request (req.user set by
 * auth middleware, req.validated set by zodValidate), call the service, and shape
 * the response envelope. No business rules, no DB access. Express 5 auto-catches
 * async errors and forwards them to the central error handler, so there are no
 * try/catch wrappers here.
 *
 * Every response uses the same envelope:
 *   success -> { success: true,  message, data, errors: null }
 *   failure -> { success: false, message, data: null, errors? }  (from the handlers)
 */
const eventService = require('./event.service');

// POST /api/events
async function create(req, res) {
  const event = await eventService.createEvent({ user: req.user, data: req.validated });
  return res.status(201).json({
    success: true,
    message: 'Event created successfully.',
    data: { event },
    errors: null,
  });
}

// GET /api/events
async function list(req, res) {
  const { page, limit, search, status } = req.validatedQuery;
  const { events, pagination } = await eventService.listEvents({
    user: req.user,
    page,
    limit,
    search,
    status,
  });
  return res.status(200).json({
    success: true,
    message: 'Events fetched successfully.',
    data: { events, pagination },
    errors: null,
  });
}

// GET /api/events/:id
async function getOne(req, res) {
  const event = await eventService.getEvent({ user: req.user, id: req.params.id });
  return res.status(200).json({
    success: true,
    message: 'Event fetched successfully.',
    data: { event },
    errors: null,
  });
}

// PATCH /api/events/:id
async function update(req, res) {
  const event = await eventService.updateEvent({
    user: req.user,
    id: req.params.id,
    data: req.validated,
  });
  return res.status(200).json({
    success: true,
    message: 'Event updated successfully.',
    data: { event },
    errors: null,
  });
}

// DELETE /api/events/:id
async function remove(req, res) {
  const event = await eventService.deleteEvent({ user: req.user, id: req.params.id });
  return res.status(200).json({
    success: true,
    message: 'Event deleted successfully.',
    data: { id: event.id },
    errors: null,
  });
}

module.exports = { create, list, getOne, update, remove };
