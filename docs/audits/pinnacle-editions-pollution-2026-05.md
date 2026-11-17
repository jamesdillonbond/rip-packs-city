# Pinnacle main-editions pollution — 2026-05-10

## Premise

`analytics_data_quality_overview().global.pinnacle_pollution_in_main_editions` reported 314 Disney Pinnacle rows
in `public.editions` that are 1:1 duplicates of rows in `public.pinnacle_editions` (matched 1:1 by
`editions.external_id = pinnacle_editions.edition_key`).

Pinnacle has its own dedicated table (`pinnacle_editions`) with a separate schema, separate ID space (`text`,
not `uuid`), and separate downstream pipeline (`pinnacle_sales`, `pinnacle_fmv_snapshots`,
`pinnacle_nft_map`). These 314 rows in the main `editions` table are pre-split residue.

You cannot just `DELETE` them — `editions.id` is referenced by 29 FK constraints. The audit work below was to
figure out which of those 29 actually have rows pointing at the 314 polluting editions, and whether each
target table has a Pinnacle-specific equivalent we could re-point to.

## FK referencer inventory

Counted on 2026-05-10. Only the parent tables are listed; partition children (sales_YYYY, fmv_snapshots_YYYY,
price_snapshots_YYYY) are subsumed by the parent count.

| Table                            | Pinnacle-edition refs | Bucket | Pinnacle-specific equivalent      |
|----------------------------------|----------------------:|--------|-----------------------------------|
| cached_listings_v2               |                     0 | (a)    | n/a                               |
| **fmv_snapshots**                |               **300** | (b)    | **pinnacle_fmv_snapshots**        |
| fmv_snapshots_2025               |                     0 | (a)    | (partition of fmv_snapshots)      |
| fmv_snapshots_2026               |                   300 | (b)    | (partition of fmv_snapshots)      |
| fmv_snapshots_2027               |                     0 | (a)    | (partition of fmv_snapshots)      |
| moments                          |                     0 | (a)    | n/a (Pinnacle uses pinnacle_nft_map) |
| offers                           |                     0 | (a)    | n/a                               |
| pack_drop_pool                   |                     0 | (a)    | n/a (TS-only)                     |
| portfolio_moments                |                     0 | (a)    | n/a                               |
| price_snapshots (all partitions) |                     0 | (a)    | n/a                               |
| sales (all partitions)           |                     0 | (a)    | pinnacle_sales                    |
| special_serial_holders           |                     0 | (a)    | n/a (TS-only)                     |
| special_serial_lookup_failures   |                     0 | (a)    | n/a                               |
| topshot_insider_buybacks         |                     0 | (a)    | n/a (TS-only)                     |
| trade_matches                    |                     0 | (a)    | n/a                               |
| user_trade_offers                |                     0 | (a)    | n/a                               |
| user_wishlists                   |                     0 | (a)    | n/a                               |
| watchlist_items                  |                     0 | (a)    | n/a                               |

**Summary:** 27 of 29 FK referencers have zero references to Pinnacle pollution. The remaining one
(`fmv_snapshots` and its 2026 partition) has 300 rows that are all in `fmv_snapshots_2026` and **all dated
within the last 20 minutes** (oldest 2026-05-10 22:40:21 UTC, newest 2026-05-10 23:00:58 UTC).

This means the pollution is being **actively written** — it didn't accumulate as legacy history, the writer is
still running. We cannot just delete 314 rows and call it done; the source has to be blocked first or the
pollution regrows within the next cron tick.

## Active source — fmv-recalc Step 5

`app/api/fmv-recalc/route.ts` Step 5 query walks `editions LEFT JOIN fmv_snapshots WHERE fs.edition_id IS
NULL`, finds the 314 Pinnacle rows in main `editions` (which have no row in main `fmv_snapshots` because
Pinnacle has its own table), and inserts a LOW-confidence backfill row with `low_ask * 0.90` from
`badge_editions`. Step 5b (historical fallback) has the same shape against `editions JOIN sales LEFT JOIN
fmv_snapshots`; Pinnacle has no rows in main `sales`, so 5b is a no-op today but would pollute if anything
ever wrote a Pinnacle row into main `sales`. Step 6 (stale touch, gated on `force_stale=true`) JOINs `editions
ON e.id = fs.edition_id` — it refreshes whatever pollution exists. Step 1 (the main recalc) drives off
`sales.edition_id`; today Pinnacle is absent from main `sales`, so Step 1 doesn't pollute, but it would if
anything ever cross-contaminated `sales`.

Per-tick counts in `pipeline_runs.extra.backfill`: 15 → 0 → 15 across the 22:41/23:00/23:01 window. The 300
rows accumulated across many earlier ticks of the same shape. fmv-recalc runs every 20min.

## Decision

Bucket (a)/(b) dominates 100% (27/29 = (a), 1/29 = (b)). Migration path is correct: re-point the (b) rows,
then delete the polluting editions. **BUT**: all 299 distinct polluting editions already have rows in
`pinnacle_fmv_snapshots` (299/299 overlap on `edition_key`), so no re-point is needed — the data is already
in the right place. The 300 polluting `fmv_snapshots` rows are pure dupes; safe to drop.

Order of operations:

1. **Source block** — patch `fmv-recalc` Steps 1/5/5b/6 to filter `collection_id != pinnacle_uuid`. Without
   this, the 314-row deletion regrows on the next 20-min tick.
2. **Cleanup migration** — delete the 300 polluting `fmv_snapshots` rows, then delete the 314 polluting
   `editions` rows.
3. **Verify** — `analytics_data_quality_overview().global.pinnacle_pollution_in_main_editions` drops to 0.

Constant: Pinnacle `collection_id` = `7dd9dd11-e8b6-45c4-ac99-71331f959714`.

## Risk notes

- **No FK refs from user-facing tables** (`user_wishlists`, `user_trade_offers`, `watchlist_items`,
  `trade_matches`). No user-saved state breaks.
- **No FK refs from sales/price_snapshots/cached_listings_v2**. No historical record loss.
- The 300 fmv_snapshots rows are duplicates of `pinnacle_fmv_snapshots` content for the same edition,
  generated by a degenerate fallback (LOW confidence, ask × 0.9). Their existence in main `fmv_snapshots`
  has no consumer — every Pinnacle FMV read in the codebase goes through `pinnacle_fmv_snapshots` (see
  `app/api/cron/populate-pinnacle-wmc-fmv/route.ts`, `lib/concierge/pinnacle-router.ts`,
  `components/pinnacle/PinnacleSniper.tsx`).
- The source-block patch is the part with non-zero risk: if any non-Pinnacle code path relies on the Step 5
  backfill row materializing for Pinnacle editions, the filter would regress it. None found in repo grep.
