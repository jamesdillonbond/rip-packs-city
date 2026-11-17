# ⛔ Falsifier re-run: the Studio Top Shot index is STILL empty — and all four candidate ask sources are now measured. There is no replacement.

**Filed 2026-08-30 ~08:30 PT (15:30Z) by the Claude Code interactive session. MEASURED, DECISION-GRADE, NOTHING SHIPPED.**

**This runs the falsifier [2026-08-29T2200Z](2026-08-29T2200Z-there-is-no-studio-replacement-for-topshot-moment-asks-the-schema-is-there-the-data-is-not.md) left open** — *"a single re-probe of `searchTopShotNft` with no filters settles it — if it ever returns non-zero, this filing's conclusion is void and the migration is back on. That is the falsifier; it costs one query."* It had sat ~17 h. **It does not fire: the conclusion stands.**

---

## Why this matters more than its size

The roadmap makes **accuracy the gate**, and the headline metric is the share of prices at HIGH/MEDIUM confidence. Top Shot is **7,114 of 19,742 priced = 36.0 %** with **1,606 STALE**, and the nightly pass measured it *declining* (7,609 → 6,983) with the cause named: the dead legacy endpoint aging editions out. `offers-sweep` is the only writer of `edition_offers.low_ask`, and `lib/fmv-confidence.ts` promotes LOW → MEDIUM on a live ask agreeing with the sales median. **No ask feed ⇒ no promotions ⇒ the gate metric decays.** So "can we get Top Shot asks from somewhere else?" is the highest-value open question on the board, and the handoff queue still carries *"Top Shot legacy→Studio client migration — code+push"* as if it were viable.

## The four candidates, all measured today

| # | source | result | verdict |
|---|---|---|---|
| 1 | `public-api.nbatopshot.com` (legacy) | 530 / `error code: 1033`, ~40 h | ⛔ dead |
| 2 | Studio `searchTopShotNft` | **totalCount 0** | ⛔ empty |
| 3 | Studio `searchTopShotMarketplaceHistory` | **totalCount 34** (unchanged in 17 h) | ⛔ negligible |
| 4 | Atlas per-serial (`topshot_active_listings`) | fresh (2.0 h) but **237 / 19,913 editions = 1.2 %** | ⚠ alive, far too narrow |
| 5 | Flowty `flowty_open_listings` | schema is `principal_amount / interest_rate / repayment_usd / borrower_addr` | ⛔ **a LOAN book, not a sale-ask feed** |

### The control matters more than the zero

⭐ **My first probe pair 422'd — and the AllDay control 422'd IDENTICALLY**, which is exactly what a control is for: it said the fault was my query, not the data. The argument is `searchInput` (not `input`) and `filters` is an ARRAY — taken from the repo's own proven client (`lib/chains/flow/allday-studio-holdings.ts`) rather than guessed a second time.

Re-run with the proven shape, **both HTTP 200 in the same batch**:

- `searchTopShotNft(searchInput:{first:1,filters:[]})` → **`totalCount 0`**
- `searchAllDayNft(searchInput:{first:1,filters:[]})` → **`totalCount 10,670,740`** ✅

**Same endpoint, same headers, same query shape, same minute.** The zero is a property of the Top Shot index, not of the probe — which is the claim the earlier filing could only make with a differently-shaped control.

### Why the Atlas feed cannot be quietly promoted

It is **alive and the freshest Top Shot ask source we have** (last seen 2.0 h ago, 264 active rows). But it is a **value-floored board feed by design** — the workflow header says *"A full **$100-floor** sweep is ~1,080 targets"* — so it exists to serve the Underpriced #1s board, not to price the catalogue. **237 editions of 19,913 is 1.2 %.** Widening it to catalogue scale is ~18× the Atlas calls, on a path that **403s Node/undici and must run curl on a GHA runner**, and which is *already* failing 6 of 16 with `egress_blocked` (#20). It is a real lever, but an expensive, operator-gated one — not a swap.

## What this closes

⛔ **The queued item "Top Shot legacy→Studio client migration (`lib/chains/flow/topshot*.ts`) — code+push" is NOT VIABLE for the ask path and should be struck from the queue**, not carried. The 2200Z filing already closed `offers-sweep` / `topshot-fmv-populate` / `badge-sync` / `moments-hydrator`; this re-confirms it after the fact, with a fresh control, and adds Flowty and Atlas-coverage as measured dead ends.

✅ **Still open and unaffected:** the `searchTopShotMarketplaceHistory` sales-history lane as a **cross-check** — but at **34 records, unchanged in 17 h**, its value is now measured and it is not worth a route. ⚠ Shipping it must never be described as outage relief.

## The honest strategic picture for Trevor

There are exactly three levers, and two are already pulled:

1. **Wait for the endpoint.** Outside our control; ~40 h and "decommissioning-shaped".
2. **Widen the Atlas feed to catalogue scale.** The only technical path to broad TS asks. Costs ~18× Atlas calls through a curl-on-GHA runner that is already partly egress-blocked (#20), and #20 needs an operator `wrangler deploy`. **Trevor's call — it is a real spend, not a code fix.**
3. **Keep the surfaces honest while asks are stale.** ✅ **ALREADY DONE** — the 2230Z filing's four surfaces all shipped (`fmv-confidence` 7-day gate, `seo` `priceValidUntil`, the %-below-FMV chip, `/api/best-offers` per-leg age).

⭐ **So the product is currently doing the right thing: it is not lying about staleness, and it cannot make the numbers fresher.** The gate metric will keep drifting down until (1) or (2). **That is a supply problem, not a bug, and it should not be re-diagnosed as one.**

## Falsifier for THIS filing

Same as its parent, and it stays cheap: re-probe `searchTopShotNft(searchInput:{first:1,filters:[]})` with the AllDay control alongside. **Non-zero voids this and puts the migration back on.** ⚠ Probe via `pg_net` — the sandbox has no egress to either host — and read `net._http_response`; ⛔ when checking the queue, select `id`/`count(*)` only, never bare `url` (that leaked a live gate key on 08-29; now recorded as the third instance in `tooling-gotchas.md`).
