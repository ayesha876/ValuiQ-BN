# Queue module

The moderator's live review queue — REST and realtime.

Week 4 Task 4.

---

## `GET /api/events/:eventId/queue/review`

Moderator-only (owner or active `EventMember`).

| Query | Values | Default |
|---|---|---|
| `page` | ≥ 1 | `1` |
| `limit` | 1–50 | `20` |
| `sortBy` | `severity` \| `flaggedAt` | `severity` |
| `status` | `FLAGGED` \| `ALL` | `FLAGGED` |

`.strict()` — an unknown param is a `400`, so a moderator who mistypes `staus=FLAGGED` is told
rather than shown an unfiltered queue they believe is filtered.

```jsonc
{
  "success": true,
  "message": "Review queue fetched successfully.",
  "data": {
    "items": [{
      "id": "…",
      "title": "Why did the roadmap change?",   // truncated at 120 chars
      "text": "…",                              // full text alongside
      "authorName": "Sarah Chen",
      "status": "live",
      "roundIndex": 0,
      "flaggedAt": "2026-08-01T11:00:00.000Z",  // entered review = submitted
      "deadlineAt": "2026-08-01T11:05:00.000Z",
      "severity": "critical",
      "secondsRemaining": 42,
      "expired": false,
      "financialExposure": {
        "tokensAtRisk": 300,      // tokens returned to attendees if this times out
        "stakerCount": 2,
        "hostForfeitCents": 7500  // real money the host loses if this times out
      }
    }],
    "pagination": { "page": 1, "limit": 20, "total": 7, "totalPages": 1 }
  },
  "errors": null
}
```

Exposure is reported in **both currencies**, never collapsed. They are different money owed to
different people, and one number would hide which.

---

## ⚠️ "Severity" is derived, because this product has no reporting

The brief's model was content flagging: posts go live, users report them, a queue forms from
reports with `severity` and `reportCount`. **ValuiQ is not that.** Nobody reports anything —
every paid post enters review on submission, and moderation is curation, not policing. There is
no `severity` field and no `reportCount` anywhere in the codebase.

What a moderator actually needs to triage by is **urgency**: which post times out first, and how
much money walks out of the door when it does. So `severity` is derived from exactly that, and
the API keeps the name so the brief's frontend contract still holds.

| Band | When |
|---|---|
| `critical` | ≤ 60s left, **or** already expired, **or** ≤ 300s with ≥ 1000 tokens staked |
| `high` | ≤ 300s left, or > 300s with ≥ 1000 tokens staked |
| `normal` | plenty of time, little at stake |
| `low` | no deadline at all — can never time out, so never urgent |

Two dimensions, because either alone misleads: time-only ranks a nearly-expired 10-token post
above a fresh 5,000-token one; money-only lets a large post expire while the moderator works.

**`reportCount` is deliberately absent** rather than faked with a zero — a field that is always
`0` reads as "nobody reported this" instead of "this concept does not exist here".

The default order is `severity DESC, flaggedAt ASC` — most urgent, longest-waiting.

**The sort runs in JavaScript, not MongoDB**, which is the one place this codebase breaks its
own filter-in-the-database rule. Severity is a function of *now*: the same document is `normal`
one minute and `critical` the next with no write in between, and no index can express that
(`$expr` against `$$NOW` would defeat every index on the collection). The set is small by
construction — undecided posts in one event — so this sorts tens of rows. If an event ever holds
enough for that to matter, the fix is a stored, periodically-recomputed band, not a cleverer
query.

---

## Realtime — the control room

**There is no second WebSocket server.** The brief asked for `ws://host/queue/live` with its own
JWT middleware; this codebase already has a Socket.IO layer whose handshake authenticates and
authorizes against the *same* rule the HTTP routes use. `event.access.js` says why that sharing
matters: *"Two copies of an access rule drift, and when they do one transport allows exactly what
the other forbids."* A second server would be a third copy.

So the queue is a **room** on the existing server: `event:<id>:control`, distinct from the
attendee room `event:<id>`. Joining requires moderator authority on that specific event, because
queue payloads carry financial exposure that attendees must not see.

Connect exactly as for the feed, with the same token:

```js
io(SOCKET_URL, { auth: { token, eventId } });                       // full snapshot
io(SOCKET_URL, { auth: { token, eventId, since: lastSeenISO } });   // catch-up only
```

| Event | Payload | When |
|---|---|---|
| `queue:snapshot` | `{ items, pagination, at }` | on connect |
| `queue:changes` | `{ items, since }` | on connect **with** `since` |
| `queue:post_added` | `{ item, at }` | a post enters review |
| `queue:post_removed` | `{ postId, decision, source, financials }` | a decision is applied |
| `queue:timer_warning` | `{ postId, eventId, deadlineAt, secondsRemaining }` | at 80% elapsed |

Attendees silently do not join — a failed check is the ordinary case for almost every
connection, so it must never disconnect a socket that is legitimately carrying the feed.

**Surviving a restart.** Nothing is held in memory. A connecting client reads its snapshot from
MongoDB; a reconnecting one passes `since` and gets everything that changed, also from MongoDB.
Restart the process mid-event and a client reconnects to exactly the state it should have. An
unparseable `since` falls back to a full snapshot — a client that cannot say where it left off
should get everything, not nothing.

**Cross-instance.** Decisions publish to a Redis-backed domain bus
([`shared/events/bus.js`](../../shared/events/bus.js)) as well as emitting locally, so a decision
taken on instance A reaches moderators held by instance B. Without Redis it degrades to
in-process delivery, which is correct for a single instance.

> ⚠️ Socket.IO's default adapter is still in-memory, so **room membership** does not span
> instances. The bus carries the *event*; delivering it to a socket on another instance also
> needs `@socket.io/redis-adapter`. That is a one-line addition flagged in `socket.js` and not
> made here — it is a deployment concern, and adding a dependency was out of scope.
