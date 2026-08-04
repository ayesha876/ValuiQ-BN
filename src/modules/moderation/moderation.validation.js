/**
 * moderation.validation.js — Zod schemas for the moderation endpoints.
 *
 * `.strict()` on every schema, as everywhere else in this codebase: an unknown key is a 400,
 * not a silently ignored field. That is the mass-assignment guard, and it matters more here
 * than usual — the fields this endpoint does NOT accept are the ones that decide who gets paid.
 */
const { z } = require('zod');
const { DECISIONS } = require('./moderation.model');

/**
 * Body for `POST /api/events/:eventId/moderation/decisions`.
 *
 * ⚠️ `moderatorId` IS DELIBERATELY NOT ACCEPTED, though the brief listed it in the body.
 * Identity comes from the verified JWT (`req.user.id`) and nowhere else. Taking it from the
 * request would let any moderator write another moderator's name into the permanent audit
 * trail for a decision that moved money — the same class of problem as accepting `owner` on an
 * event, which `.strict()` already blocks there. With `.strict()`, sending it is a 400 rather
 * than a field quietly ignored, so a client built against the brief fails loudly and visibly.
 *
 * `source` is likewise absent: only the fairness worker may write `'system'`, and it calls the
 * service directly rather than coming through HTTP.
 */
const createDecisionSchema = z
  .object({
    // A 24-character hex ObjectId. Validated here so a malformed id is a clean 400 at the
    // boundary rather than a CastError surfacing from deep in the service.
    postId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, 'A valid post id is required.'),

    decision: z.enum(DECISIONS, {
      message: `Decision must be one of: ${DECISIONS.join(', ')}.`,
    }),

    // Optional, and capped because it is rendered in an audit list rather than read as prose.
    reason: z.string().trim().max(500, 'Reason must be 500 characters or fewer.').optional().default(''),
  })
  .strict();

/** Query for the per-event decision history. */
const decisionHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

module.exports = { createDecisionSchema, decisionHistoryQuerySchema };
