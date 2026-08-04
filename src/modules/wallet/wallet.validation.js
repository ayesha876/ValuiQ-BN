/**
 * wallet.validation.js — Zod schema for the dev grant endpoint.
 *
 * `.strict()` is the mass-assignment guard, exactly as in event.validation.js: the caller
 * cannot smuggle a userId, a type, or a fiatCents through the body. The grant always credits
 * the AUTHENTICATED caller, taken from the verified token and never from input.
 */
const { z } = require('zod');

// Capped well below anything that would distort a load test's numbers, and high enough to be
// useful for one. A grant is a development convenience, not a way to mint an arbitrary balance.
const MAX_GRANT = 10_000;

const grantTokensSchema = z
  .object({
    amount: z.coerce
      .number()
      .int('Token amounts are whole numbers.')
      .min(1, 'Grant at least 1 token.')
      .max(MAX_GRANT, `Grant at most ${MAX_GRANT} tokens at a time.`),
  })
  .strict();

module.exports = { grantTokensSchema, MAX_GRANT };
