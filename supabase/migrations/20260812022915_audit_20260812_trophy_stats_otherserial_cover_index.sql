-- audit_20260812_trophy_stats_otherserial_cover_index
--
-- RECORD migration (documents an out-of-band DDL; not the mechanism that built it).
--
-- Covering partial index on sales_2026 that fixes the topshot_first_mint_trophy_stats
-- slow board (public /insights/first-mint stats KPIs). Its backing view's
-- `other_serial_avg` CTE filtered `collection_id = <TS> AND serial_number > 1 AND
-- price_usd > 0 AND sold_at >= now()-180d` and Parallel-Seq-Scanned sales_2026
-- (~376k rows, ~88% of the plan). No existing index served it: the ed_med index
-- (idx_sales_2026_ts_edition_median) keys on `collection` (text) not `collection_id`
-- (uuid) and its partial is `price_usd > 0.50`, so it's disqualified for a
-- `collection_id = <uuid> AND price_usd > 0` query.
--
-- Measured (2026-08-11 PT, on a quiet DB):
--   topshot_first_mint_trophies plan cost 54,956 -> 30,190 (other_serial_avg node
--   48,617 -> 23,851, now a Parallel Index Only Scan);
--   topshot_first_mint_trophy_stats EXPLAIN ANALYZE Execution Time 17,308 ms -> 2,047 ms
--   (now under the 5,400 ms liveness budget). ~153k residual Heap Fetches will decline
--   as autovacuum sets sales_2026's visibility map on older 180d-window pages.
--
-- HOW IT WAS BUILT: via a one-off pg_cron job running CREATE INDEX CONCURRENTLY
-- outside a transaction block (the MCP/apply_migration path wraps in a txn, where
-- CIC cannot run). Build: 35.8 s, index 61 MB, indisvalid = true. The one-off job
-- was unscheduled after the build.
--
-- This file records the object for repo/schema parity. It is NOT re-applied by the
-- MCP (the index already exists; a CONCURRENTLY statement cannot run inside
-- apply_migration's transaction). IF NOT EXISTS makes any hypothetical fresh replay
-- a safe no-op.
--
-- REVERT: DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2026_ts_otherserial_cover;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_2026_ts_otherserial_cover
  ON public.sales_2026 USING btree (collection_id, sold_at DESC)
  INCLUDE (edition_id, price_usd)
  WHERE serial_number > 1 AND price_usd > 0;
