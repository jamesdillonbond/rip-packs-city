-- Twin of idx_sales_2026_ts_edition_median on the sales_2027 partition.
--
-- WHY NOW: the 180-day median window that feeds mv_topshot_edition_median_180d
-- and the perfect-mint-premiums MV's ed_med CTE will start reaching into
-- sales_2027 around January 2027. Today sales_2027 holds ZERO rows, so this
-- build is instantaneous and takes no meaningful lock -- doing it now avoids a
-- CREATE INDEX CONCURRENTLY on a hot multi-hundred-thousand-row partition later,
-- which is exactly the operation that could not be run from the interactive
-- tooling for sales_2026 (60s cap) and had to be hand-run in a quiet window.
--
-- Without it, the 2027 partition falls back to a heap-fetch storm and the MV
-- refresh timeouts return -- silently, months from now, looking like a new bug.
--
-- Read-path index only. No data change. Mirrors the 2026 definition exactly.
--
-- Applied to prod 2026-08-08 via MCP apply_migration; verified indisvalid=true.
--
-- Revert: DROP INDEX IF EXISTS public.idx_sales_2027_ts_edition_median;
CREATE INDEX IF NOT EXISTS idx_sales_2027_ts_edition_median
  ON public.sales_2027 USING btree (edition_id, sold_at DESC)
  INCLUDE (price_usd)
  WHERE ((collection = 'nba_top_shot'::text) AND (price_usd > 0.50));
