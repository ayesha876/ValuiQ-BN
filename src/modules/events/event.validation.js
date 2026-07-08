/**
 * event.validation.js — the Zod schemas that are the SINGLE SOURCE OF TRUTH for
 * event input. The route runs these through zodValidate before the controller, so
 * the controller/service only ever see clean, typed data.
 *
 * `.strict()` (top level AND on nested objects) rejects any unknown key — that's
 * the mass-assignment guard: a client cannot smuggle `owner`, `slug`, or `status`
 * in through the body. The server sets those from trusted sources instead.
 */
const { z } = require('zod');
const { STATUSES } = require('./event.model'); // reuse the real enum (generic, not hardcoded)

// Optional form fields often arrive as '' — treat that as "not provided" so a
// half-filled draft validates instead of erroring on an empty string.
const emptyToUndefined = (v) => (v === '' || v === null ? undefined : v);

const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());
const optionalNonNegInt = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(0).optional(),
);
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url('Enter a valid URL.').optional());

const moderatorSchema = z
  .object({
    name: z.string().trim().min(1, 'Moderator name is required.'),
    email: z.string().trim().toLowerCase().email('Enter a valid moderator email.'),
  })
  .strict();

// Fields shared by create + update (spread into each so rules are written once).
const eventFields = {
  name: z.string().trim().min(1, 'Event name is required.').max(120),
  description: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
  bannerUrl: optionalUrl,
  startDate: optionalDate,
  endDate: optionalDate,
  segment: z
    .object({
      type: z.enum(['instant', 'hotlist']).optional(),
      timeLimit: optionalNonNegInt, // minutes
      submissionLimit: optionalNonNegInt, // N
    })
    .strict()
    .optional(),
  pricing: z
    .object({
      minPostCost: optionalNonNegInt,
      minVoteCost: optionalNonNegInt,
    })
    .strict()
    .optional(),
  neglectTimer: optionalNonNegInt, // seconds
  merchUrl: optionalUrl,
  moderators: z.array(moderatorSchema).optional(),
  discountCodes: z.array(z.string().trim().min(1)).optional(),
};

// end >= start only matters when BOTH are present (a draft may have neither).
const endAfterStart = (d) => !(d.startDate && d.endDate) || d.endDate >= d.startDate;
const endAfterStartMsg = {
  message: 'End date must be on or after the start date.',
  path: ['endDate'],
};

// Optional custom event link (slug) — CREATE only. Sanitized to a URL-safe form
// (a pasted full URL is reduced to its last segment); junk that cleans to nothing
// or is too short is rejected. Uniqueness + reserved-word checks live in the
// service (they need the DB / app-route knowledge, not just input shape).
const customSlugField = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .transform((s) =>
      s
        .split('/')
        .pop()
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .refine((s) => s.length >= 3 && s.length <= 60, {
      message: 'Event link must be 3–60 characters: letters, numbers, or hyphens.',
    })
    .optional(),
);

// CREATE — `intent` tells the server draft vs go-live; status is NEVER client-set.
// `slug` is the ONLY system-ish field a client may propose (validated here, then
// re-checked in the service); update omits it, so .strict() keeps the link fixed.
const createEventSchema = z
  .object({
    intent: z.enum(['draft', 'live']).default('draft'),
    slug: customSlugField,
    ...eventFields,
  })
  .strict()
  .refine(endAfterStart, endAfterStartMsg);

// UPDATE — every field optional (PATCH); intent optional (no default so an update
// never silently flips status).
const updateEventSchema = z
  .object({ intent: z.enum(['draft', 'live']).optional(), ...eventFields })
  .partial()
  .strict()
  .refine(endAfterStart, endAfterStartMsg);

// Query params for GET /api/events. Coerced + clamped + sanitized at the boundary
// so bad input becomes a clean 400 and never reaches the DB. Non-strict on purpose:
// query params don't map to DB fields (the repo picks only status/search), so extra
// params (analytics, cache-busters) are harmlessly stripped rather than 400'd.
const listEventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  search: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
  status: z.enum(STATUSES).optional(),
});

module.exports = { createEventSchema, updateEventSchema, listEventsQuerySchema };
