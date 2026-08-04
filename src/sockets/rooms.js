/**
 * rooms.js — the naming convention for Socket.IO rooms.
 *
 * One line of logic, but it lives in its own file on purpose: the room name is a contract
 * shared by the handshake (which joins) and every future module (which broadcasts). If posts
 * emitted to `event:<id>` while the handshake joined `events/<id>`, nothing would arrive and
 * nothing would error — the worst kind of bug. One definition means they cannot drift.
 *
 * Matches the client contract documented in `ValuiQ _ FN/mock/README.md`.
 */

/** The room every participant in one event shares. */
function roomForEvent(eventId) {
  return `event:${String(eventId)}`;
}

module.exports = { roomForEvent };
