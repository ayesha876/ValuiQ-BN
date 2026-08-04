/**
 * event.model.js — the Event schema (the shape of an event document in MongoDB).
 *
 * This is the "model" layer: it ONLY describes data + data-level rules (types,
 * enums, indexes). No business logic and no request handling live here.
 *
 * Draft-friendly by design: only `name` (plus the system-managed `slug`/`owner`/
 * `status`) is required, so a half-filled "Save as Draft" can persist. The FULL
 * required set (dates + pricing) is enforced in the service layer at Go Live, not
 * here — a draft is allowed to be incomplete.
 */
const mongoose = require('mongoose');

// The lifecycle states an event moves through. `status` is server-managed.
const STATUSES = ['draft', 'scheduled', 'live', 'ended'];

// The two opening-segment delivery modes (mirrors the Create Event form).
const SEGMENT_TYPES = ['instant', 'hotlist'];

// Event-level feed format. `open` = the single Opening Segment is the whole event.
// `segmented` = the Opening Segment is stage 0 and `rounds` are stages 1..n.
const FEED_FORMATS = ['open', 'segmented'];

// Embedded moderator row (name + email only) — matches the current Create Event
// form's moderator rows. Real invites/accept are a later module; `_id: false`
// keeps these rows lightweight since they're addressed by email, not id.
const moderatorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
  },
  { _id: false },
);

// One segmented "round" (stage 1..n). Mirrors the Opening Segment's exact shape
// (segment + pricing + neglectTimer) plus a per-round shortlistSize — so a "stage"
// has one identical shape across the document. Subdocs KEEP their default `_id` so
// each row is stably addressable; the API exposes it as `id` (see toJSON below), and
// the frontend deliberately never echoes that id back so `.strict()` input stays clean.
// Config-only today: nothing consumes rounds yet (no submissions/voting/shortlist engine).
const roundSchema = new mongoose.Schema({
  segment: {
    type: { type: String, enum: SEGMENT_TYPES, default: 'instant' },
    timeLimit: { type: Number, min: 0 }, // minutes
    submissionLimit: { type: Number, min: 0 }, // N — max submissions
  },
  pricing: {
    minPostCost: { type: Number, min: 0 },
    minVoteCost: { type: Number, min: 0 },
  },
  neglectTimer: { type: Number, min: 0 }, // seconds
  shortlistSize: { type: Number, min: 0 }, // the one genuinely new per-round field
});

// Mirror the parent doc's convention: expose `id`, hide `_id`/`__v` on each round.
roundSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const eventSchema = new mongoose.Schema(
  {
    // The only field a draft truly needs. Everything else may be filled later.
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: '' },

    // Hosted banner image URL (set after a Cloudinary upload — later phase).
    bannerUrl: { type: String, trim: true, default: '' },

    // --- SYSTEM-MANAGED: never accepted from the client ---
    // Public link segment, generated server-side from `name`. UNIQUE so two events
    // can never share a link (the unique index also makes slug lookups fast).
    slug: { type: String, required: true, unique: true },
    // Who owns this event. Set from the verified JWT (req.user), never the body,
    // so an organizer can't create events under someone else's account.
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Lifecycle state the server controls (Save Draft -> draft, Go Live -> live).
    status: { type: String, enum: STATUSES, default: 'draft', index: true },

    // Soft-delete marker. null = active; a Date = deleted at that time. Reads
    // exclude these by default; the document is kept so ended events' token/payment
    // history stays recoverable. No dedicated index — the owner-scoped queries
    // already narrow to a small set before this filter applies.
    deletedAt: { type: Date, default: null },

    // Optional on a draft; required at Go Live (enforced in the service).
    startDate: { type: Date },
    endDate: { type: Date },

    // Opening segment configuration.
    segment: {
      type: { type: String, enum: SEGMENT_TYPES, default: 'instant' },
      timeLimit: { type: Number, min: 0 }, // minutes
      submissionLimit: { type: Number, min: 0 }, // N — max submissions
    },

    // Token costs. Optional on a draft; required at Go Live (enforced in service).
    pricing: {
      minPostCost: { type: Number, min: 0 },
      minVoteCost: { type: Number, min: 0 },
    },

    neglectTimer: { type: Number, min: 0 }, // seconds a post waits before neglect

    // --- SYSTEM-MANAGED: the host's cut of realised post value, as a percentage ------------
    // What share of a post's money-value this host keeps when a decision books revenue. 100 =
    // the host keeps everything the audience spent; anything lower is the platform's margin.
    //
    // NOT IN `event.validation.js`, and that omission is the design. The validation schemas
    // are `.strict()`, so a field absent from them is rejected outright — which means a host
    // cannot PATCH their own commercial terms to 100%. It belongs with `owner`, `status` and
    // `slug` in the server-managed set: settable by an admin tool or a seed, never by the
    // client that stands to gain from it.
    //
    // Per-event rather than global because the brief requires configurable splits, and deals
    // genuinely differ by event. Default 100 preserves today's behaviour exactly.
    revenueSharePct: { type: Number, min: 0, max: 100, default: 100 },

    // --- Event format (open feed vs segmented rounds) ---
    // `feedFormat` gates the two modes; `rounds` holds the segmented stages 1..n
    // (the Opening Segment above stays as stage 0). Each round mirrors the opening
    // shape + a per-round shortlistSize. Nothing reads rounds yet — config capture only.
    feedFormat: { type: String, enum: FEED_FORMATS, default: 'open' },
    rounds: { type: [roundSchema], default: [] },

    // --- Live timing (server-owned) ---------------------------------------
    // WHEN the clock started. `segment.timeLimit` says how long a stage lasts, but until now
    // nothing recorded when it began — so the participation window the attendee screen counts
    // down to was uncomputable. Set when the event goes live; null before that.
    roundStartedAt: { type: Date, default: null },

    // WHICH stage is live. 0 is the Opening Segment; 1..n index into `rounds`. The client is
    // never allowed to work this out from elapsed time — it owns no more of the round than it
    // owns of the ranking.
    //
    // ⚠️ Nothing ADVANCES this yet. Round advancement (closing a window, cutting the shortlist,
    // opening the next stage) is a mechanism that does not exist in this codebase. The field
    // gives it somewhere to write when it is built.
    currentRoundIndex: { type: Number, default: 0, min: 0 },

    merchUrl: { type: String, trim: true, default: '' },

    moderators: { type: [moderatorSchema], default: [] },
    discountCodes: { type: [String], default: [] }, // imported from CSV later
  },
  {
    // Adds createdAt / updatedAt automatically.
    timestamps: true,
  },
);

// --- Indexes ---
// Serves the "list only my events, newest first" query (GET /events) in a single
// indexed scan. `status` has its own index (above) for filtering drafts vs live.
eventSchema.index({ owner: 1, createdAt: -1 });

// Mirror the User model: expose `id`, hide `_id`/`__v` so API responses match the
// shape the frontend already consumes.
eventSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const Event = mongoose.model('Event', eventSchema);

module.exports = Event;
module.exports.STATUSES = STATUSES;
module.exports.SEGMENT_TYPES = SEGMENT_TYPES;
module.exports.FEED_FORMATS = FEED_FORMATS;
