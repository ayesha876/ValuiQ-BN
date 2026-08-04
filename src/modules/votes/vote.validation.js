/**
 * vote.validation.js — Zod schema for casting a vote.
 *
 * `.strict()` keeps the caller from smuggling a postId or a voter through the body: the post
 * comes from the URL, the voter from the token. SHAPE ONLY — whether the stake clears the
 * event's minimum needs the event, so that rule lives in the service.
 */
const { z } = require('zod');

const castVoteSchema = z
  .object({
    tokens: z.coerce
      .number()
      .int('Token amounts are whole numbers.')
      .min(1, 'A stake must be at least 1 token.'),
  })
  .strict();

module.exports = { castVoteSchema };
