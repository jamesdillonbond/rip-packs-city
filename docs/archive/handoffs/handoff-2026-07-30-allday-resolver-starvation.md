# Handoff — 2026-07-30 · the AllDay resolver starves its own backlog by recency

> ## ⛔ REFUTED AND CLOSED — 2026-07-29 (PT), Claude Code. DO NOT IMPLEMENT THE FIX BELOW.
>
> Every load-bearing claim in this document was measured live before acting; the diagnosis did not survive. **Its proposed fix (split the candidate budget 60/40 newest/oldest) would have made the breached metric WORSE.** Full evidence + revert path: `docs/overnight/ledger.md`, entry **"2026-07-29 (Claude Code, interactive) — SHIPPED: `unmapped_resolution_backlog_max` given a 24h grace period"**.
>
> 1. **The metric excludes the tail this fix targets.** `unmapped_resolution_backlog_max` counts only `sold_at > now() - 30 days` ("aged residual excluded ... signals NEW stalls not the historical floor"). The six-month tail contributes **zero**, so spending 40% of `ON_CHAIN_MAX` on `sold_at ASC` diverts budget away from the only rows the metric counts.
> 2. **The numbers below use the wrong predicate.** They omit the route's own `price_usd > 0` filter ([route.ts:199](../app/api/cron/allday-resolve-unmapped/route.ts#L199)). True queue is **28,044 unresolved / 14,116 never-attempted**, not 55,047 / 40,384. The 27,002-row gap is `price_usd = 0`, structurally excluded by design and unreachable by any ordering change.
> 3. **The starvation mechanism does not exist.** There are **zero fresh never-attempted rows** — the frontier is `sold_at` 2026-07-26, 3.5 days old, so nothing jumps the queue. Rotation runs at **6,782 stamps/24h** against a 14,116 pool (~2.1 days to drain); over a 14-day `REATTEMPT_AFTER_DAYS` cycle capacity is ~95k attempts vs 28k rows needing one — **3.4× oversupplied**.
> 4. **`candidates` pinned at ~398 is not the tell this doc reads it as.** It is `LIMIT 400` minus nft_id dupes, and reads ~398 whether or not rotation works.
> 5. **The real cause of the 106 was the metric, not the resolver.** The resolver was healthy (93/93 ok runs, 961 rows resolved/24h, fresh sales resolving at **p50 6.6 min / p99 34 min**, 85–100% per day). A high-volume day (283 arrivals vs 74) put its own **in-flight** tail into a metric with no grace period. Fixed by excluding rows sold in the last 24h; `breach_at` stayed 100. Positive control: a 1-day stall would read 136 → still breaches.
>
> The scale note below is also misleading: the 15.5% per-attempt resolve rate is the aged tail (genuinely unresolvable — Dapper custody / storefront escrow, already proven on-chain) diluting an 85–100% fresh-sale rate. **Neither resolver route was changed.** The `WMC-REALIGN-VS-WALLET-WALK-EDITION-KEY-LOOP` item at the bottom remains correctly deferred.

## Context

This is the root cause of the only breached trust metric — `unmapped_resolution_backlog_max = 106` vs 100. Nothing shipped from Cowork; this is a route change with a precedent already in the repo.

**The resolver is healthy.** 94 runs / 94 ok / 1,785 rows written in 24h. It is not stalled, not erroring, not degraded. It simply cannot reach most of its queue.

---

## 20. `allday-resolve-unmapped` never reaches aged rows

**File:** `app/api/cron/allday-resolve-unmapped/route.ts`, candidate selection at lines ~193–203.

```ts
const reattemptCutoff = new Date(Date.now() - REATTEMPT_AFTER_DAYS * 86_400_000).toISOString()  // 14 days
  .or(`last_onchain_attempt_at.is.null,last_onchain_attempt_at.lt.${reattemptCutoff}`)
  .order("last_onchain_attempt_at", { ascending: true, nullsFirst: true })
  .order("sold_at", { ascending: false })     // ← newest first, inside the never-attempted group
  .limit(CANDIDATE_LIMIT)                     // 400
```

### The numbers

| | |
|---|---|
| AllDay unresolved | **55,047** |
| …never attempted | **40,384** |
| …never attempted **and** older than 48h | **40,372** |
| oldest never-attempted sale | **2026-01-27** (six months) |
| attempted at least once | 14,663 |
| on-chain attempts per run | **~60** (`onchain_attempted` capped) |
| new rows ingested / 24h | ~3,558 |

Never-attempted rows sort first (`nullsFirst`), and **within that group the tiebreak is `sold_at DESC`.** So every tick works the *newest* never-attempted sales. New sales arrive continuously and keep jumping the queue, so the 40,372 aged never-attempted rows are permanently outranked. They are not failing — **they are never tried.**

Direct confirmation on the 62 rows driving the breach: **43 were attempted exactly once, all at the same moment 57.6h ago, none since; 19 have never been attempted at all.** Their data is complete — 0 null `nft_id`, 0 null `buyer_address` — so this is not an unresolvable-row problem.

The 43 also will not come back soon: `REATTEMPT_AFTER_DAYS = 14`, and at ~60 attempts/run the attempted pool of 14,663 cycles on the order of days-to-weeks, so a row stamped 2.4 days ago sits idle regardless.

### ⚠ The previous fix moved this bug rather than removing it

The comment block at lines 83–93 documents the original defect exactly: *"`ORDER BY sold_at DESC LIMIT CANDIDATE_LIMIT` with no cursor, offset … forever, so EVERY tick re-selected the same rows — `candidates` was pinned at …"*, fixed by adding `last_onchain_attempt_at`.

That fix rotates **attempted** rows correctly. It left the never-attempted group ordered `sold_at DESC`, so the identical starvation persists one level down. `candidates` is still pinned — 396, 398, 396, 398 across consecutive runs — which is the same tell the comment was written about.

### The fix, with in-repo precedent

**Split the candidate budget between newest and oldest never-attempted.** This codebase already solved the same problem the same way: per the ledger, `backfill_pack_rip_metadata`'s budget was split **40% stale-already-valued (oldest first) / 60% newest-NULL drain** for exactly this reason. Mirror it.

Concretely — two queries instead of one, unioned to `CANDIDATE_LIMIT`:

- **~60%** never-attempted `ORDER BY sold_at DESC` — protects the user-visible path so fresh sales still resolve within minutes.
- **~40%** never-attempted `ORDER BY sold_at ASC` — drains the six-month tail.

Do **not** simply flip to `sold_at ASC`; that starves new sales instead, which is the worse trade since recent sales are what users see.

At ~40% of 60 attempts/run × ~96 runs/day ≈ 2,300 aged rows/day, the 40,372 tail clears in roughly 18 days while current sales stay fresh.

**Verify:** `candidates` stops being pinned near 398; `still_unresolved` falls consistently rather than hovering ~55,050; the count of never-attempted-and-aged drops run over run; `unmapped_resolution_backlog_max` returns under 100.

**Revert:** revert the commit — selection logic only, no data change.

### Scale note, not blocking

`onchain_nil` is **52–60 of every 60 attempts** — roughly 90% of on-chain lookups return nothing, and the route already self-flags `onchain_unproductive: true`. Draining faster will not by itself resolve rows that genuinely cannot be resolved on chain. But it will separate "cannot resolve" from "never tried", which today are indistinguishable — and that is the prerequisite for deciding whether the aged tail is worth chasing at all or should be explicitly frozen the way the multi-NFT rows already are.

---

## Also open, already queued by Claude Code

`WMC-REALIGN-VS-WALLET-WALK-EDITION-KEY-LOOP` — 4 rows realigned nightly and reverted within hours by a wallet-walk writer overwriting `edition_key`. The control is already in the data: rows on the constantly-walked wallet revert, the same nft on a cold wallet (`last_seen_at` 06-10) stayed fixed. Correctly deferred — it needs a scoped pass on an ingest-adjacent write path, not a tail-end edit.

## Guardrails

Unchanged.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

The aged never-attempted tail drains at a predictable rate without delaying fresh sales; `candidates` is no longer pinned; and `unmapped_resolution_backlog_max` is back under its threshold for a reason that is understood rather than coincidental.
