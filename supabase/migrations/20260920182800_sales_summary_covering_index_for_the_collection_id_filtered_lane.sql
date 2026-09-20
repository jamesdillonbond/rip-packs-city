-- 2026-09-20 · idx_sales_{2026,2027}_summary_cover — make analytics_sales_summary's
-- filtered `w` CTE an INDEX ONLY SCAN, and retire the index it supersedes.
--
-- WHAT THIS CORRECTS. Register row R121 (filed earlier the same day) recorded that
-- `/api/analytics/sales/summary` 500s for Top Shot on a 7-day window, and prescribed a
-- covering index keyed on `(collection, sold_at DESC)`. Both halves were re-derived
-- today on a quiet instance and BOTH WERE WRONG:
--
--   1. THE SYMPTOM DOES NOT REPRODUCE. Measured through the production caller at
--      2026-09-20 ~11:20 PT, all three of R121's recorded 500s return 200 with
--      `x-vercel-cache: MISS`:
--        summary?collections=topshot&window=l7   -> 200, 14,636 sales
--        summary?window=l30                      -> 200, 97,991 sales
--        summary?window=all                      -> 200, 2,077,366 sales
--        top-moves?collections=topshot&window=l7 -> 200, 20 rows
--      R121 measured the estate's IO spell (`refresh_mv_pack_ev_latest` had been
--      running 7m57s with nearly every backend on IO/DataFileRead), not a structural
--      defect. The panel was never permanently dead.
--
--   2. THE KEY COLUMN WAS WRONG. `analytics_sales_summary` filters on
--      `s.collection_id = ANY($4)` — a uuid — not on `s.collection`. An index keyed on
--      `(collection, sold_at)` cannot serve that predicate at all. R121 reached its
--      conclusion from a probe that filtered on `collection` while production filters
--      on `collection_id`: the harness differed from production in the one dimension
--      the answer depended on.
--
-- WHAT IS REAL. The filtered lane took a plain Index Scan and heap-fetched every row,
-- which is what makes this panel the first casualty of the next IO spell. Measured
-- warm, the production CTE shape (Top Shot, l7, 14.6k rows), BEFORE:
--
--     Index Scan using sales_2026_collection_id_sold_at_idx
--     Buffers: shared hit=9475          Execution Time: 1010.5 ms
--
-- AFTER this index:
--
--     Index Only Scan using idx_sales_2026_summary_cover
--     Heap Fetches: 2653
--     Buffers: shared hit=2387          Execution Time: 42.9 ms
--
-- -75% buffers, -96% wall clock, warm-vs-warm on the same quiet instance.
--
-- WHY FIVE INCLUDE COLUMNS. The first build carried four
-- (price_usd, buyer_address, seller_address, marketplace) — exactly the set R121 named
-- — and the planner IGNORED IT, still choosing the narrow index. The `w` CTE also reads
-- `s.collection` for its `CASE ... END AS collection` (the collection_breakdown), and a
-- column the query reads but the index lacks forecloses an index-only scan. R121's own
-- falsifier is what caught this: "if it still heap-fetches, the INCLUDE list is
-- incomplete — print the plan, not the predicate." The plan, printed, named the gap.
--
-- WHY THE OLD COVER IS DROPPED, WITH THE NUMBER. `idx_sales_2026_collid_soldat_cover`
-- (2026-08-01, 91 MB, INCLUDE (marketplace, price_usd)) has the IDENTICAL key and an
-- INCLUDE list that is a strict subset of this one, so it is redundant by construction.
-- Its consumer is `get_daily_marketplace_volume()`, which has a 15s statement_timeout
-- and a 36s incident behind it, so the regression was MEASURED rather than assumed —
-- warm-vs-warm, Top Shot / 30d / 80,253 rows:
--     with the old 91 MB cover : 19,135 buffers, 61.5 ms
--     with this 124 MB cover   : 19,214 buffers, 63.1 ms   (+0.4% buffers, +1.6 ms)
-- Both remain Index Only Scans. Net effect on the write-hot 2026 partition: index COUNT
-- unchanged at 25, total index bytes +33 MB.
--
-- 2027 GETS IT TOO. The partition is empty today, so the build is free, and
-- `get_daily_marketplace_volume` has no upper `sold_at` bound — it already reads 2027.
-- Building now removes a cliff on 2027-01-01.
--
-- HOW IT WAS APPLIED — and a DATED CORRECTION to this repo's own record.
-- `20260828225200_idx_pack_rips_dist_agg_covering.sql` states that CREATE INDEX
-- CONCURRENTLY "is unreachable via MCP `execute_sql`/`apply_migration`". That is no
-- longer true for `execute_sql`: all four statements below ran through MCP
-- `execute_sql` on 2026-09-20, each returning within the cap, each verified
-- `indisvalid = true` immediately afterwards. `apply_migration` still cannot run them
--
-- 🚨 CORRECTION TO THE PARAGRAPH ABOVE, same day, ~90 minutes later. Those four
-- CIC statements ran on the LARGE tier: `pg_postmaster_start_time()` is
-- 2026-09-20 10:39:57 AM PT, a Small -> Large resize (max_connections 90 -> 160,
-- shared_buffers 2 GB, sustained disk 22 -> 79 MB/s). 2026-08-28 s finding was
-- made on SMALL. A faster box finishing inside the cap says NOTHING about the box
-- that could not, so treat "CIC is reachable via execute_sql" as established for
-- LARGE only, and re-derive it before relying on it anywhere else. Every buffer
-- count in this file is unaffected -- pages touched is not IO throughput.
-- (it wraps its body in a transaction). No `schema_migrations` row was recorded, on
-- purpose: `check-migration-parity` reads prod -> repo, so a committed file with no
-- prod row is not drift, and an `apply_migration` here would have bought one bookkeeping
-- row at the cost of a 10-20s user-facing PGRST002 burst.
--
-- This file is the repo record of objects created outside the migration channel. It is
-- written IF NOT EXISTS / IF EXISTS so it is a no-op on any environment already in this
-- state.
--
-- REVERT (exact, both halves):
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2026_summary_cover;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2027_summary_cover;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_2026_collid_soldat_cover
--     ON public.sales_2026 USING btree (collection_id, sold_at DESC)
--     INCLUDE (marketplace, price_usd);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_2026_summary_cover
  ON public.sales_2026 USING btree (collection_id, sold_at DESC)
  INCLUDE (price_usd, buyer_address, seller_address, marketplace, collection);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_2027_summary_cover
  ON public.sales_2027 USING btree (collection_id, sold_at DESC)
  INCLUDE (price_usd, buyer_address, seller_address, marketplace, collection);

DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2026_collid_soldat_cover;

COMMENT ON INDEX public.idx_sales_2026_summary_cover IS
  'Covering index for the (collection_id, sold_at) analytics lane. Supersedes idx_sales_2026_collid_soldat_cover (dropped 2026-09-20): identical key, strictly wider INCLUDE. The fifth payload column `collection` is load-bearing — analytics_sales_summary''s w CTE reads it for collection_breakdown, and without it the planner declines the index-only scan entirely. Top Shot l7 warm: 9,475 buffers / 1010 ms -> 2,387 buffers / 43 ms.';

COMMENT ON INDEX public.idx_sales_2027_summary_cover IS
  'Same shape as idx_sales_2026_summary_cover, built while the 2027 partition is empty so there is no cliff on 2027-01-01. get_daily_marketplace_volume() has no upper sold_at bound and already reads this partition.';
