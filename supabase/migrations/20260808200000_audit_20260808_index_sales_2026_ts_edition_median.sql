-- Perf / disk-IO: index sales_2026 for the perfect-mint-premiums MV refresh.
--
-- rpc-refresh-perfect-mint-premiums (mv_topshot_perfect_mint_premiums_board, a
-- 163-row / 128 kB MV) burned ~2,417 s/day and failed ~9/23 runs at the 600s
-- ceiling because its `ed_med` CTE (per-edition 180d median of TS sales) used
-- (edition_id, price_usd) and then HEAP-FETCHED ~406,000 rows just to apply the
-- collection + sold_at filters. On the Small tier's disk-IO-budget model (bursts,
-- then throttles to 22 MB/s baseline) that random-read storm was the top single
-- source of the intermittent saturation that 504'd /api/market, /api/sentinel,
-- price-snapshots and entity pages on 2026-08-08.
--
-- This partial covering index makes ed_med an INDEX-ONLY, pre-sorted-by-edition_id
-- scan (validated live: EXPLAIN shows `Index Only Scan using
-- idx_sales_2026_ts_edition_median`, no heap fetches). The DB is NOT capacity-
-- bound (2/90 connections active, CPU idle) — decision with Trevor was to stay on
-- the Small compute tier and fix the queries, not pay 4x for Medium (same 2 cores).
--
-- ⚠ Applied to prod out-of-band via the Supabase SQL editor on 2026-08-08 (Trevor),
-- NOT by this file: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- (so not via apply_migration) and the full-partition build exceeds the 60s
-- interactive-tool cap. This file exists for repo<->DB parity only; re-running it
-- is a no-op (IF NOT EXISTS). To (re)apply, paste into the SQL editor / a psql
-- session, ideally in a low-disk-IO window.
--
-- Revert: DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2026_ts_edition_median;
-- Follow-up: add the twin on sales_2027 before the 180d window creeps into it
-- (~5 months), and apply the same heap-fetch-storm treatment to the other 5
-- timing-out MV refreshes (topshot-edition-median likely shares this exact shape).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_2026_ts_edition_median
ON public.sales_2026 (edition_id, sold_at DESC)
INCLUDE (price_usd)
WHERE collection = 'nba_top_shot' AND price_usd > 0.50;
