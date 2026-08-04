/**
 * revenue.routes.js — URLs and middleware for host earnings.
 *
 * Not event-scoped, unlike moderation: earnings are a property of a HOST across every event
 * they run, so the resource is the host. Ownership is enforced in the controller rather than by
 * a middleware guard, because the check is a single id comparison against the token and does
 * not need to load anything first.
 */
const express = require('express');
const { z } = require('zod');
const authMiddleware = require('../../shared/middlewares/auth.middleware');
const zodValidate = require('../../shared/middlewares/zodValidate.middleware');
const { REVENUE_STATUSES } = require('./revenue.model');
const controller = require('./revenue.controller');

const router = express.Router();

const entriesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: z.enum(REVENUE_STATUSES).optional(),
  })
  .strict();

// An empty schema, still `.strict()`: a stray query param on the summary is a 400 rather than
// something silently ignored, matching how every other endpoint here treats unknown input.
const summaryQuerySchema = z.object({}).strict();

router.use(authMiddleware);

router.get('/host/:hostId/summary', zodValidate(summaryQuerySchema, 'query'), controller.getSummary);
router.get('/host/:hostId/entries', zodValidate(entriesQuerySchema, 'query'), controller.listEntries);

module.exports = router;
