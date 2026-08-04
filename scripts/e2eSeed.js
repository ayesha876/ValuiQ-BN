/**
 * scripts/e2eSeed.js — create the fixture the Playwright E2E needs, and print it as JSON.
 *
 * The alternatives were worse: a test-only seeding ENDPOINT would put routes in the product
 * that exist purely for tests, and driving signup through the UI would make every moderation
 * test also a test of OTP email verification.
 *
 * Run:  node scripts/e2eSeed.js > e2e-fixture.json
 * Then: E2E_FIXTURE="$(cat e2e-fixture.json)" npx playwright test
 *
 * ⚠️ Local/throwaway databases only — it creates users and a live event, and the grant it uses
 * is the non-production dev endpoint.
 */
const mongoose = require('mongoose');
require('../src/modules/auth/auth.model');
require('../src/modules/events/event.model');
const { signLoginToken } = require('../src/shared/utils/generateToken');

const MONGO = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/valuiq_e2e';
const API = process.env.E2E_API || 'http://localhost:5000';

(async () => {
  await mongoose.connect(MONGO);
  const User = mongoose.model('User');
  const Event = mongoose.model('Event');
  const stamp = Date.now();

  const host = await User.create({ email: `zze2e-host-${stamp}@valuiq.local`, role: 'Event Organizer', isVerified: true });
  const attendee = await User.create({ email: `zze2e-attendee-${stamp}@valuiq.local`, role: 'Attendee', isVerified: true });

  const event = await Event.create({
    name: 'E2E Moderation Event',
    slug: `zze2e-${stamp}`,
    owner: host.id,
    status: 'live',
    roundStartedAt: new Date(),
    feedFormat: 'open',
    // A long window so the participation freeze never makes the spec flaky, and a long neglect
    // timer so no card expires mid-test.
    segment: { type: 'instant', timeLimit: 120 },
    pricing: { minPostCost: 100, minVoteCost: 50 },
    neglectTimer: 3600,
  });

  const attendeeToken = signLoginToken(attendee);
  const hostToken = signLoginToken(host);

  // Fund the attendee through the real endpoint, so the fixture cannot drift from how the
  // product actually grants tokens.
  const funded = await fetch(`${API}/api/wallet/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${attendeeToken}` },
    body: JSON.stringify({ amount: 5000 }),
  }).then((r) => r.ok).catch(() => false);

  if (!funded) {
    console.error(`Could not fund the attendee via ${API}. Is the backend running on the same MONGO_URI?`);
    process.exit(1);
  }

  console.log(JSON.stringify({ eventId: event.id, attendeeToken, hostToken }));
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
