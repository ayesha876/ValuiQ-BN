/**
 * post.validation.js — Zod schemas for the posts endpoints.
 *
 * `.strict()` is the mass-assignment guard: a client cannot smuggle `status`, `author`,
 * `roundIndex` or `authorName` through the body. Every one of those is set by the server from
 * a trusted source — the token, the loaded event, or the stage.
 *
 * SHAPE ONLY. Whether the stake clears the event's minimum, and whether the attendee has
 * submissions left, are business rules that need the event — they live in the service, beside
 * the same kind of rule in event.service.js.
 */
const { z } = require('zod');

const createPostSchema = z
  .object({
    // 500 matches the composer's own counter, so the client-side limit and the server-side one
    // cannot drift apart and produce a post that types fine and fails on submit.
    text: z.string().trim().min(1, 'Write something before posting.').max(500, 'Posts are limited to 500 characters.'),

    // The stake. Whole tokens only — they are not divisible.
    tokens: z.coerce
      .number()
      .int('Token amounts are whole numbers.')
      .min(0, 'A stake cannot be negative.'),
  })
  .strict();

const reviewPostSchema = z
  .object({
    decision: z.enum(['approve', 'reject'], {
      message: "Decision must be either 'approve' or 'reject'.",
    }),
  })
  .strict();

module.exports = { createPostSchema, reviewPostSchema };
