# Revenue module

The host's real money: what they earned, and what was clawed back.

Week 4 Task 3. Called only by [`../moderation`](../moderation/README.md) once a decision has
been claimed — it never decides anything itself.

---

## Two currencies, never mixed

| | Lives in | Unit | Destination |
|---|---|---|---|
| Attendee | `Wallet` / `LedgerEntry` | **tokens** (whole) | spent in-app |
| Host | `HostWallet` / `HostRevenueEntry` | **cents** (integer) | a real bank, via Stripe |

A moderation decision is the moment one becomes the other. Separate collections with separate
units is what stops someone one day adding a token count to a cent count.

---

## The conversion

A token is worth **what its owner paid for it, on average across their purchases**
(`QinMvpDocs.md` §6). So a post is valued staker by staker:

```
postValueCents = Σ  floor( staker.tokens × staker.centsPerToken )

staker.centsPerToken = Σ purchase.fiatCents / Σ purchase.tokens     // 'purchase' entries only
hostEarnedCents      = floor( postValueCents × sharePct × decisionPct / 10000 )
```

- **Grants are excluded** from the rate. Granted tokens were never paid for; averaging them in
  would understate what the audience genuinely spent. An attendee with no purchases has a rate
  of **0** — they are still refunded their tokens on a neglect, but the host earns no real money
  from them. That is every attendee today, until Stripe lands in Week 5.
- **Rounding always floors, once.** Rounding to nearest would, across thousands of posts, credit
  hosts money nobody paid. The floored remainder is simply not booked. The invariant: *the sum
  of everything booked can never exceed the sum of everything paid.*

---

## API

### `GET /api/revenue/host/:hostId/summary`

A host may only read their own. `403` otherwise (no admin bypass — `src/modules/admin/*` is
still empty; when a role lands, it belongs in the controller).

```jsonc
{
  "success": true,
  "message": "Earnings summary fetched successfully.",
  "data": {
    "summary": {
      "hostId": "…",
      "pendingCents": 3750,          // authoritative spendable balance, from HostWallet
      "bookedCents": 3750,           // summed from entries
      "voidedCents": 0,
      "paidCents": 0,                // Week 6 payouts set this
      "lifetimeBookedCents": 3750,
      "entryCount": 2
    }
  },
  "errors": null
}
```

`pendingCents` comes from the wallet and the rest from the entries — deliberately not derived
from one another, because a divergence between them is exactly the bug worth surfacing.

### `GET /api/revenue/host/:hostId/entries?limit=50&status=booked`

The individual entries. Each carries its full calculation (`grossValueCents`, `sharePct`,
`decisionPct`, `amountCents`) so a host disputing a figure can be answered without re-deriving
inputs that have since moved.

---

## Configurable split

`Event.revenueSharePct` (0–100, default 100) is the host's cut.

**It is server-managed and deliberately absent from `event.validation.js`.** Those schemas are
`.strict()`, so a field they do not list is rejected — which means a host cannot PATCH their own
commercial terms to 100%. It belongs with `owner`, `status` and `slug`: settable by an admin
tool or a seed, never by the client that stands to gain.

---

## Idempotency

Two independent guarantees on "never pay a host twice":

1. The unique index on `ModerationDecision.post` (upstream, in moderation).
2. The unique index on `HostRevenueEntry.post` (here).

`bookEntry` returns `{ created: false, entry }` on a duplicate rather than throwing, and the
wallet is credited only when `created` is true. Refunds use deterministic keys
(`neglect:<postId>:<userId>`) against the unique index on `LedgerEntry.idempotencyKey`, so a
partially-completed refund loop is safe to simply re-run.

---

## ⚠️ Why there is no `AttendeeRefund` collection

The brief asked for one. It is deliberately not built.

`LedgerEntry` is already the single source of truth for token movement — append-only, signed,
and carrying `type: 'refund'` and `ref.postId`, both added in Week 3 specifically so Week 4
could use them (`wallet.model.js:17`: *"`refund` exists so the mechanism is ready for Week 4
moderation"*).

A second table recording the same refunds would be a copy that can disagree with the ledger, and
when they disagree there is no way to tell which is right — precisely the failure the ledger
exists to prevent. So "the refund records for a post" is a **query** over the ledger
(`revenue.repository`/`walletRepo.findRefundsForPost`, exposed as
`revenueService.getRefundsForPost`) rather than a duplicate write.

The brief's `PENDING` status also does not apply here: a token refund is an immediate wallet
credit, with no payment processor in the path. `PENDING` will be real in **Week 6**, for host
payouts, which do involve Stripe.

---

## Known gaps

- **A clawback can exceed the host's pending balance** if they were paid out between earning on
  a post and that post being reversed. The entry is still voided (it is genuinely not earned) and
  the shortfall is logged at `error` — driving a balance negative to keep the books tidy would be
  worse than a visible discrepancy. Reconciling against the payout is Week 6's problem.
- **`paidCents` is never set.** Nothing pays out yet; Week 6 owns that transition.
