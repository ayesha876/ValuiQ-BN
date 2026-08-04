# Moderation module

Settles a paid post: who gets the money, and who gets it back.

This is the Week 4 deliverable — the moderation decision API (Task 1) and the fairness timer
(Task 2). Revenue booking lives in [`../revenue`](../revenue/README.md); the review queue lives
in [`../queue`](../queue/README.md).

---

## The business rule

| Decision | Post becomes | Host earns | Stakers refunded |
|---|---|---|---|
| `address` | `addressed` | **100%** of realised value | No |
| `dismiss` | `dismissed` | **50%** | No |
| `neglect` | `neglected` | **0%** | **Yes — every staker, in full** |

Source: `ValuiQ_Client_Overview.docx` §9 and `QinMvpDocs.md` §6, which agree.

**"Realised value" is not `post.tokens`.** A token is worth what its owner paid for it on
average across their purchases, so a post is valued staker by staker and summed. Two people
staking 100 tokens each can be worth very different amounts of real money. See
[`tokenValueCalculator.js`](../../shared/utils/tokenValueCalculator.js).

**Every staker means the author too.** The author's opening stake lives on the post
(`openingStake`), not in a `Vote` row, so a refund built only from vote rows would miss the one
person who started the thread.

---

## API

All routes are event-scoped and require **moderator authority on that event** — the event owner
or an active `EventMember`. Any global role is fine; the vestigial global `Moderator` role is
deliberately *not* checked.

### `POST /api/events/:eventId/moderation/decisions`

```jsonc
// Request
{
  "postId": "507f1f77bcf86cd799439012",   // required, 24-char hex
  "decision": "address",                   // required: address | dismiss | neglect
  "reason": "Great question"               // optional, ≤500 chars
}
```

```jsonc
// 201 Created — first application
{
  "success": true,
  "message": "Post addressed.",
  "data": {
    "post": { "id": "…", "status": "addressed", "tokens": 300, … },
    "decision": {
      "id": "…",
      "decision": "address",
      "source": "moderator",       // or "system" when the fairness timer settled it
      "reason": "Great question",
      "appliedAt": "2026-08-01T12:00:00.000Z"
    },
    "financials": {
      "hostEarnedCents": 7500,     // REAL MONEY, in cents
      "grossValueCents": 7500,     // before the host's share was applied
      "refundedTokens": 0,         // IN-APP TOKENS — a different currency
      "stakerCount": 2
    }
  },
  "errors": null
}
```

| Status | When |
|---|---|
| `201` | Decision applied for the first time |
| `200` | **Replay** — the same decision was already applied; original figures returned |
| `400` | Bad body, unknown key (incl. `moderatorId`), or malformed `postId` |
| `401` | No/invalid token |
| `403` | Not a moderator of this event, **or deciding your own post** (see below) |
| `404` | Post does not exist, or belongs to another event |
| `409` | A **different** decision already exists, or one is mid-flight |
| `422` | Post is in a state that cannot be decided (e.g. `rejected`) |
| `429` | More than 300 decisions in 15 minutes from one IP |

### `GET /api/events/:eventId/moderation/decisions?limit=50`

The event's audit trail, newest first. Each row carries `source`, so a host can see which posts
they settled and which the timer settled for them.

---

## Nobody settles their own post

`requireEventModerator` proves you may decide posts in this event. It says nothing about **whose**
post — and both moderator roles can also be authors: a host may post into their own event, and an
`EventMember` is an ordinary attendee with a badge. So the service checks the author separately and
answers `403`.

The harm this prevents is specific. On **Address**, the other people who staked on that post have
their tokens converted into the host's earnings rather than refunded — and the person choosing that
outcome is the one whose post it is. Afterwards it is invisible: the audit trail records a
legitimate moderator taking a legitimate decision.

`403` rather than `409`: the decision is well-formed and the post is decidable — the caller is
simply not allowed to be the one who takes it. The post stays decidable by anyone else.

**`source: 'system'` is exempt by construction.** The fairness timer has no identity to collide
with the author's, so a moderator's own post is still auto-neglected on schedule. Without that
exemption, a moderator could park their own post past every deadline precisely because nobody was
allowed to settle it.

> The publication gate (`PATCH /posts/:id/review`) has no equivalent check. It moves no money, so
> the exposure is a moderator publishing their own post rather than one settling it — lower
> severity, and still worth closing.

---

## Deviations from the Week 4 brief

Four, each deliberate:

1. **Not `/api/v1/…`.** This API is unversioned by an earlier explicit decision
   (`VALUIQ_EVENTS_BACKEND_HANDOFF` §5). Versioning one module would make it the only versioned
   path in the app.
2. **Event-scoped, not a flat collection.** Authorization is per-event, so the guard needs the
   event in the path and must run *before* any post is read. A flat route would have to read a
   post to discover whether you may read it.
3. **`moderatorId` is not accepted in the body.** Identity comes from the JWT. Accepting it
   would let any moderator write another's name into a permanent money audit trail. `.strict()`
   turns sending it into a 400 rather than a silent ignore.
4. **No Prisma transaction.** There are none in this codebase — `wallet.service.js` explains
   that Mongo sessions need a replica set the test runner does not provide. See below.

---

## How atomicity works without a transaction

Settlement is built so that **running it twice is indistinguishable from running it once**:

```
1. CLAIM   insert a ModerationDecision. UNIQUE INDEX on `post` → exactly one caller proceeds.
2. FREEZE  settle the post's status. `addTokens` only matches `status: 'live'`, so this is
           what stops new stakes landing mid-refund.  ← ordering is load-bearing, not cosmetic
3. VALUE   read the now-frozen stake set, price it per staker.
4. SETTLE  book revenue, or refund. Every money write uses a DETERMINISTIC idempotency key
           (`neglect:<postId>:<userId>`), so a re-run is a no-op.
5. RECORD  mark the decision applied with what it actually cost.
```

A crash after step 1 leaves a `pending` decision naming the post and intended outcome; re-running
completes only what is missing. That is stronger than all-or-nothing — a transaction protects one
attempt, this protects every retry. Which matters more here, because **a double refund cannot be
undone.**

The unique index collapses all of these to the same safe outcome:

- two moderators clicking simultaneously
- the fairness worker racing a moderator
- a client retrying after a timeout
- two worker instances sweeping the same post

---

## The fairness timer

> "You are automatically and fully refunded — you never lose tokens due to a delay outside your
> control." — `ValuiQ_Client_Overview.docx` §24

**The deadline is the host's, not a global constant.** `neglectTimer` is per-stage, in
**seconds**, set on the Create Event form and shown to attendees as an accountability
commitment. The brief's global `FAIRNESS_TIMEOUT_HOURS=48` would have silently overridden every
host who configured one — so it is only a fallback for a stage that left it blank.

The deadline is **frozen onto the post** (`neglectDeadlineAt`) at submission, so editing the
host's timer later cannot move a deadline attendees were already shown.

Two mechanisms, deliberately redundant:

| | Needs | Gives |
|---|---|---|
| BullMQ delayed job | Redis | refunds **on time**, to the second |
| Database sweep | nothing | refunds **at all**, within one sweep interval |

Losing the first is a degraded experience; losing the second would be losing money. Only one of
those may depend on infrastructure being up — which is why **Redis is optional**: without
`REDIS_URL` the app runs normally and auto-neglect falls back to the sweep.

Running both, on many instances, is safe: settlement is claimed through the unique index, so N
sweeps refund each post exactly once. That is what makes the worker horizontally scalable — no
distributed lock, because the database already provides mutual exclusion.

**Timer warning.** The brief asked for a warning 1 hour before timeout. Neglect timers are
commonly 30–300 **seconds**, so a fixed hour would fire before the post was submitted. It warns
at a configurable *fraction* elapsed instead (`FAIRNESS_WARN_FRACTION`, default `0.8`).

**Dead letter queue.** BullMQ moves exhausted jobs to its `failed` set, retained 7 days
(`removeOnFail`). The `failed` handler in the worker emits a structured
`DEAD LETTER — fairness job exhausted its retries` line at `error` level — that is the alerting
hook. It is deliberately not wired to a pager: this codebase has no alerting transport, and
inventing one inside a worker is how a half-configured pager ships.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | *(unset)* | Enables punctual timers. Unset is supported. |
| `FAIRNESS_DEFAULT_TIMER_SECONDS` | `300` | Fallback when a stage sets no `neglectTimer`. |
| `FAIRNESS_MAX_TIMER_SECONDS` | `86400` | Ceiling on a host-configured timer. |
| `FAIRNESS_WARN_FRACTION` | `0.8` | Warn at 80% elapsed. |
| `FAIRNESS_SWEEP_INTERVAL_SECONDS` | `60` | Safety-net sweep cadence. |
| `FAIRNESS_WORKER_CONCURRENCY` | `5` | BullMQ worker concurrency. |

---

## ⚠️ Known gaps and open questions

1. **Where does the other 50% of a Dismiss go?** The host banks 50%. The documentation does not
   say what happens to the rest: it is not refunded ("tokens remain spent") and not booked. It
   is currently left **unbooked** — implicitly platform margin. That is the literal reading, but
   it is a commercial decision and should be confirmed before real money flows.

2. **A `rejected` post keeps the attendee's tokens.** The Week 3 publication gate can reject a
   post with no refund and no host revenue, and a rejected post cannot then be decided (`422`).
   This is pre-existing, not introduced here, and it is a money-policy question rather than a
   code one — Week 4 deliberately does not invent an answer.

3. **No repair sweep for `pending` decisions.** `moderation.repository.findStuck()` exists and
   nothing calls it. Mirrors the same gap `wallet.service.js` documents for `pending` ledger
   rows; both want one small reconciliation job.

4. **A vote can be charged for and lost.** `vote.service.js` debits, then calls
   `postRepo.addTokens` (which filters `status: 'live'` and may return null), then writes the
   `Vote` row unconditionally. If a post is settled in between, the voter is charged and the
   post total never moves. Moderation is immune — refunds read `Vote` rows and `openingStake`,
   so that voter is still refunded — but the post's *rank* was briefly wrong. Fixing it belongs
   in the votes module.
