/**
 * generateOtp.js — makes the 6-digit email verification code.
 *
 * WHY crypto instead of Math.random(): Math.random() is predictable and not
 * meant for anything security-related. Node's built-in `crypto` gives us a
 * cryptographically strong random number, so codes can't be guessed by pattern.
 */
const crypto = require('crypto');

/**
 * Returns a 6-digit numeric code as a STRING (e.g. "042917").
 * It's a string, not a number, so a leading zero is never dropped.
 */
function generateOtp() {
  // randomInt(min, max) gives an integer in [min, max). 100000..999999 keeps it
  // a full 6 digits; padStart is a belt-and-suspenders guard for the range.
  const code = crypto.randomInt(100000, 1000000);
  return String(code).padStart(6, '0');
}

module.exports = generateOtp;
