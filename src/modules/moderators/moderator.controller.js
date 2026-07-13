/**
 * moderator.controller.js — the thin HTTP layer for moderator invites/memberships.
 *
 * Reads what it needs from the request (req.user set by auth middleware, req.event
 * set by requireEventOrganizer, req.validated set by zodValidate), calls the service,
 * and shapes the response envelope. No business rules, no DB access. Express 5
 * auto-catches async errors, so there are no try/catch wrappers here.
 *
 * Envelope (as everywhere): success -> { success:true, message, data, errors:null }.
 */
const moderatorService = require('./moderator.service');

// POST /api/events/:eventId/moderators/invite
async function invite(req, res) {
  const { invite: created, resent } = await moderatorService.inviteModerator({
    event: req.event,
    email: req.validated.email,
    inviter: req.user,
  });
  return res.status(201).json({
    success: true,
    message: resent ? 'Invitation re-sent.' : 'Invitation sent.',
    // Never return the token — only safe, useful fields.
    data: {
      invite: {
        id: created.id,
        email: created.email,
        status: created.status,
        expiresAt: created.expiresAt,
      },
    },
    errors: null,
  });
}

// GET /api/events/:eventId/moderators
async function list(req, res) {
  const { moderators } = await moderatorService.listModerators({ event: req.event });
  return res.status(200).json({
    success: true,
    message: 'Moderators fetched successfully.',
    data: { moderators },
    errors: null,
  });
}

// POST /api/moderators/accept
async function accept(req, res) {
  const { eventId, role, eventName } = await moderatorService.acceptInvite({
    userId: req.user.id,
    token: req.validated.token,
  });
  return res.status(200).json({
    success: true,
    message: 'Invitation accepted.',
    data: {
      membership: { eventId, role },
      // A small event summary so the FE can show/redirect after accepting.
      event: { id: eventId, name: eventName },
    },
    errors: null,
  });
}

// DELETE /api/events/:eventId/moderators/invites/:inviteId
async function revokeInvite(req, res) {
  const { id } = await moderatorService.revokeInvite({
    event: req.event,
    inviteId: req.params.inviteId,
  });
  return res.status(200).json({
    success: true,
    message: 'Invitation cancelled.',
    data: { id },
    errors: null,
  });
}

// DELETE /api/events/:eventId/moderators/:memberId
async function revokeMember(req, res) {
  const { id } = await moderatorService.revokeMember({
    event: req.event,
    memberId: req.params.memberId,
  });
  return res.status(200).json({
    success: true,
    message: 'Moderator removed.',
    data: { id },
    errors: null,
  });
}

module.exports = { invite, list, accept, revokeInvite, revokeMember };
