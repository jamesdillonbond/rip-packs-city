-- 2026-10-28: two facts, two columns. fmv_snapshots.days_since_sale is read everywhere as the age of the edition's
-- LAST SALE — the edition page prints it ("last sale N days ago"), the moment page hides the 30-day count by it, and
-- fmv_snapshots_zero_stale_sales_count zeroes sales_count_30d whenever it exceeds 30. But fmv-recalc's main loop stamped
-- it from the grail-spike-CLEANED pricing set, so when an edition's only recent sale was a stripped spike (a #3 at
-- $8.90 over a $1 cluster, a #1/5 at $150, a #99/99 last mint) the column read the age of an older sale, and the
-- trigger then zeroed a real 30-day count. Measured 10-28 over the latest snapshot per edition (3 days): 103 Top Shot
-- + 30 All Day editions overstated their last-sale age by > 2 days; 28 published "no sale in 30 days" over a real one.
-- The engine now writes the true last market sale's age into days_since_sale and the age of the newest sale the PRICE
-- rests on into basis_days_since_sale — what the sniper's staleness penalty means by "how old is this FMV's evidence",
-- so the sniper keeps exactly its current conservatism. Writers that do not know a basis leave it NULL; readers fall
-- back to days_since_sale.
-- get_editions_latest_fmv_wide_v2 is get_editions_latest_fmv_wide (unchanged, still read by /api/fmv, wallet-search and
-- cache-refresh) plus the trailing column, for the sniper feed. A new name rather than a DROP + CREATE of the original:
-- the MCP write path refuses a migration carrying DROP (memory: db-write-paths-when-mcp-writes-cancel), and adding a
-- RETURNS TABLE column cannot be done by CREATE OR REPLACE.
-- anon-exec: revoked (get_editions_latest_fmv_wide_v2) — service-role read by /api/sniper-feed; REVOKE below, GRANT to service_role only, as its v1 sibling.
-- revert: DROP FUNCTION public.get_editions_latest_fmv_wide_v2(uuid[]); ALTER TABLE public.fmv_snapshots DROP COLUMN basis_days_since_sale;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.fmv_snapshots ADD COLUMN IF NOT EXISTS basis_days_since_sale integer;
COMMENT ON COLUMN public.fmv_snapshots.basis_days_since_sale IS
  'Days since the newest sale the published FMV rests on (after grail-spike cleaning). days_since_sale is the age of the edition''s last market sale. NULL when the writer does not separate the two.';

CREATE OR REPLACE FUNCTION public.get_editions_latest_fmv_wide_v2(p_edition_ids uuid[])
RETURNS TABLE(edition_id uuid, collection_id uuid, fmv_usd numeric, floor_price_usd numeric, wap_usd numeric, confidence text,
              top_shot_ask numeric, flowty_ask numeric, cross_market_ask numeric, computed_at timestamp with time zone,
              algo_version text, asp_without_outliers numeric, sales_count_30d integer, days_since_sale integer,
              liquidity_rating integer, basis_days_since_sale integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- plpgsql, not LANGUAGE sql: a sql-language function is planned param-blind and this
  -- plan's whole value is the per-id index probe (see get_editions_latest_fmv).
  RETURN QUERY
  SELECT e.id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.asp_usd, s.confidence::text,
         s.top_shot_ask, s.flowty_ask, s.cross_market_ask, s.computed_at, s.algo_version,
         s.asp_without_outliers, s.sales_count_30d, s.days_since_sale, s.liquidity_rating,
         s.basis_days_since_sale
  FROM unnest(COALESCE(p_edition_ids, ARRAY[]::uuid[])) AS e(id)
  CROSS JOIN LATERAL (
    SELECT fs.collection_id, fs.fmv_usd, fs.floor_price_usd, fs.asp_usd, fs.confidence,
           fs.top_shot_ask, fs.flowty_ask, fs.cross_market_ask, fs.computed_at, fs.algo_version,
           fs.asp_without_outliers, fs.sales_count_30d, fs.days_since_sale, fs.liquidity_rating,
           fs.basis_days_since_sale
    FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id
      AND fs.computed_at <= now()
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) s;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_editions_latest_fmv_wide_v2(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_editions_latest_fmv_wide_v2(uuid[]) TO service_role;
