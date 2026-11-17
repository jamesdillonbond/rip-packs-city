# LaLiga Golazos sales-ingestion gap — scoping

**Date:** 2026-05-20
**Status:** Scoped, not fixed. Real indexer work — clean handoff.
**Trigger:** "The Golazos 23-sales gap."

---

## Headline

The `sales` table holds **exactly 23 Golazos rows, ever** — all `source='onchain'`,
spanning 2026-04-17 → **2026-05-09**. No Golazos sale has reached `sales` in 11 days.
Golazos has been a published collection since 2023 with 581 editions; 23 lifetime
recorded sales is not a gap, it is a near-total miss.

---

## Where the sales actually are

| Location | Source | Rows | Date range | State |
|---|---|---:|---|---|
| `sales` | `onchain` (V2 Flowty fork) | 23 | 2026-04-17 → 2026-05-09 | recorded |
| `unmapped_sales` | `flowty_archive_extractor` | 2,958 | 2023-11-22 → 2026-03-28 | unresolved |
| `unmapped_sales` | `onchain` (V2 Flowty fork) | 10 | 2026-05-13 | unresolved |
| `unmapped_sales` | `onchain_dapper_v2` | 1 | 2026-05-18 | unresolved |
| `sales` | `onchain_dapper_v1` | **0** | — | — |

So ~2,969 Golazos sales are sitting unresolved in `unmapped_sales` and only 23 ever
made it to `sales`. The indexer is *capturing* a trickle (11 rows in May via the V2
paths) but they fail edition resolution and never get promoted.

---

## The indexer itself is healthy

`golazos-sales-indexer` runs every ~20 min, `ok=true`, 240 runs in 3 days. It scans
the right places — confirmed against `app/api/golazos-sales-indexer/route.ts`:

- V1 Dapper: `A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted`
- V2 Dapper: `A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted`
- V2 Flowty: `A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted`
- Golazos filter: `nftType.endsWith(".Golazos.NFT")` — matches `A.87ca73a41bb50ad5.Golazos.NFT`, correct.

A representative tick's `extra`:

```
raw_v1_events: 25,  v1_non_golazos: 25,  v1_filtered_in: 0
raw_v2_dapper_events: 27,  v2_dapper_filtered_in: 0
v2_dapper_typeids_seen: [PackNFT, Pinnacle, MFLPack]
```

The 25 V1 events per tick are genuine AllDay/UFC sales sharing the V1 storefront —
the filter rejecting them is **correct behaviour**, not a bug. The indexer is doing
its job; it simply isn't seeing Golazos sales on the paths it watches.

---

## Two distinct problems

### Problem 1 — zero V1 Dapper Golazos capture

The May 18 V1 NFTStorefront refactor (see CLAUDE.md) was traced and **verified
against a real AllDay purchase** (JJLSmith Mahomes, NFT 9430364). It then *assumed*
"AllDay / Golazos / UFC native sales route through V1 Dapper NFTStorefront." That
assumption was never verified for Golazos — and the data now shows 0 V1 Golazos
sales across hundreds of ticks.

Either (a) Golazos has genuinely near-zero V1 marketplace activity, or (b) Golazos
native sales route through a path the indexer doesn't watch. This cannot be
resolved from the database — it needs an on-chain trace.

**Required:** Flowscan-trace one real recent Golazos sale (mirror the May 18 AllDay
method) to confirm the actual venue + event path. If it's V1 Dapper, the gap is
genuine low activity and nothing is broken. If it's elsewhere, add that path.

### Problem 2 — captured Golazos sales fail edition resolution

The 11 May rows the V2 paths *did* capture went to `unmapped_sales`, not `sales`,
because edition resolution failed. This is the same family as the
`allday-unmapped-resolver` problem: no `nft_edition_map` coverage for Golazos and
no working `decodeV1SaleTx` resolution fallback for the Golazos collection.

**Required:** Build/populate Golazos edition resolution so captured sales promote
into `sales`. This would also recover a portion of the 2,958 historical
`flowty_archive_extractor` rows.

---

## Effort estimate

| Task | Effort |
|---|---|
| Flowscan-trace a real Golazos sale, confirm venue/event path (Problem 1) | ~0.5 day |
| If a new path is found: add it to the indexer + cursor + tests | ~1–1.5 days |
| Golazos edition-resolution path (Problem 2) | ~1–2 days |
| Backfill/promote recoverable `unmapped_sales` rows | ~0.5 day |
| **Total** | **~2.5–4.5 days** |

---

## Roadmap context — read before committing time

`docs/roadmap-2026-05.md` explicitly says to **stop pouring engineering into
eroding external venues** and that LaLiga Golazos currently shows a "status
uncertain" banner. Before spending 3–4 days here, decide whether Golazos sales
intelligence is still a product goal. If Golazos is winding down, Problem 1 may
resolve to "genuinely no activity — nothing to fix," and the honest move is to
surface the gap in the UI rather than chase the indexer. Problem 2 (edition
resolution) is the more defensible half — it recovers real historical data and
shares machinery with the AllDay resolver.
