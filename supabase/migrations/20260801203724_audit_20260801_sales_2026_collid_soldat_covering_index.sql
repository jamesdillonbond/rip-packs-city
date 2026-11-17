-- audit_20260801_sales_2026_collid_soldat_covering_index
--
-- CAUSE
--   GET /api/market-analytics?collection=nba-top-shot returned HTTP 500
--   "Query failed." for Top Shot ONLY (AllDay 18,870 sales / Pinnacle 7,307 /
--   Golazos 102 all answered fine; UFC's 0 is honest), so the Top Shot
--   Analytics -> Market tab could never populate. The route calls
--   public.get_daily_marketplace_volume(collection_id, start_iso), which has
--   SET statement_timeout TO '15s'.
--
-- EVIDENCE (measured 2026-08-01, live, 30-day window, TS uuid)
--   EXPLAIN (ANALYZE, BUFFERS) of the function body:
--     Execution Time: 36,240 ms   -- 2.4x the function's own 15 s budget
--     Index Scan using sales_2026_collection_id_sold_at_idx
--       rows=87,690
--       Buffers: shared hit=35,664 read=16,782 written=23
--   i.e. 52,446 buffer accesses for 87,690 rows on a 32,252-page (252 MB)
--   partition -- the index carries (collection_id, sold_at DESC) but the query
--   also needs `marketplace` and `price_usd`, so every single row took a random
--   HEAP fetch. Under the Micro instance's IOPS ceiling those 16,782 cold reads
--   are the whole 36 s. Nothing is wrong with the plan or the function; the
--   access path just is not covering. sales_2026 is 96.1% all-visible
--   (relallvisible 30,984 / relpages 32,252), so an index-only scan is available.
--
-- FIX
--   A covering index for the exact (collection_id, sold_at) lane, with the two
--   payload columns in INCLUDE so the scan is index-only. This is a NEW
--   standalone index on the sales_2026 partition; the existing
--   sales_2026_collection_id_sold_at_idx is a partition of the parent index
--   public.idx_sales_collection and therefore cannot be dropped independently,
--   so it stays. ~+20 MB on an 11.5 GB database.
--
--   Built NON-CONCURRENTLY on purpose: CREATE INDEX CONCURRENTLY exceeded the
--   tooling's 2-minute cap twice and left an INVALID index behind (cleaned up:
--   DROP INDEX public.idx_sales_2026_collid_soldat_cover). A plain build inside
--   this transaction is atomic -- a timeout rolls back cleanly with no leftover.
--
-- REVERT SQL (exact)
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2026_collid_soldat_cover;

CREATE INDEX IF NOT EXISTS idx_sales_2026_collid_soldat_cover
  ON public.sales_2026 USING btree (collection_id, sold_at DESC)
  INCLUDE (marketplace, price_usd);

COMMENT ON INDEX public.idx_sales_2026_collid_soldat_cover IS
  'Covering index for get_daily_marketplace_volume() and the (collection_id, sold_at) analytics lane. INCLUDE (marketplace, price_usd) makes the scan index-only; without it the Top Shot 30d window did 16,782 cold heap reads and blew the function''s 15s timeout (36.2s), 500-ing /api/market-analytics. See audit_20260801_sales_2026_collid_soldat_covering_index.';
