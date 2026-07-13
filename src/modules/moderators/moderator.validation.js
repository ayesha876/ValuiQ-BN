/**
 * moderator.validation.js — the Zod schemas that are the SINGLE SOURCE OF TRUTH for
 * the moderator endpoints' request bodies. The route runs these through zodValidate
 * before the controller, so the controller/service only ever see clean, typed data.
 *
 * `.strict()` rejects any unknown key (the mass-assignment guard), mirroring
 * event.validation.js — a client can't smuggle extra fields (event/status/role/etc.)
 * through the body; those are set server-side from the route params + the JWT.
 */
const { z } = require('zod');

// POST /api/events/:eventId/moderators/invite — the organizer invites ONE address.
// email is normalized (trim + lowercase) so it matches the stored, lowercased invite
// email, keeps the accept-time email match case-insensitive, and makes the
// partial-unique {event,email} guard behave predictably.
const inviteModeratorSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  })
  .strict();

// POST /api/moderators/accept — the invited user submits the raw token from the link.
// It's opaque here (just a non-empty, length-bounded string); the service hashes it
// and looks it up. The max is a cheap guard against absurd payloads — the real token
// is a fixed ~43-char base64url string, so 200 is generous headroom.
const acceptInviteSchema = z
  .object({
    token: z.string().trim().min(1, 'Invite token is required.').max(200),
  })
  .strict();

module.exports = { inviteModeratorSchema, acceptInviteSchema };
