-- Snapshot migration: public.fmv_apply_thin_sale_haircut(uuid,boolean).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01; byte-identical, md5
-- 67d33fe865c082fc6ca1b74a7a3dac14) so it can carry a pinned invariant test.
-- Applying it is a no-op against prod.
--
-- What it does: an FMV-INTEGRITY writer. For the latest snapshot per edition it
-- haircuts fmv_usd on thin-liquidity editions where FMV has collapsed onto the
-- ask floor (fmv ~= floor within $0.01, sales_count_30d <= 2, confidence
-- LOW/ASK_ONLY) -- the "an ask masquerading as a sale-backed price" class. The
-- multiplier deepens as liquidity thins (0.85 with a sale / 0.75 many sellers /
-- 0.65 few / 0.55 single-seller-or-unknown) and stamps algo_version '..._haircut'.
-- p_dry_run computes the counts/dollars but writes NOTHING (operator preview).

CREATE OR REPLACE FUNCTION public.fmv_apply_thin_sale_haircut(p_collection_id uuid DEFAULT NULL::uuid, p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_haircut bigint, total_dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_examined bigint := 0;
  v_haircut  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  -- Build a CTE of latest-per-edition snapshots that need haircut, with computed adjusted FMV
  WITH latest AS (
    SELECT DISTINCT ON (edition_id) *
    FROM fmv_snapshots
    WHERE (p_collection_id IS NULL OR collection_id = p_collection_id)
    ORDER BY edition_id, computed_at DESC
  ),
  candidates AS (
    SELECT
      l.id AS snapshot_id,
      l.computed_at,
      l.edition_id,
      l.fmv_usd AS old_fmv,
      l.floor_price_usd,
      l.sales_count_30d,
      l.listing_count,
      -- Haircut multiplier based on sales + listing depth
      CASE
        WHEN COALESCE(l.sales_count_30d, 0) >= 3 THEN 1.00  -- no haircut
        WHEN COALESCE(l.sales_count_30d, 0) >= 1 THEN 0.85  -- mild
        WHEN COALESCE(l.listing_count, 0)  >= 5 THEN 0.75  -- multi-seller, no sales
        WHEN COALESCE(l.listing_count, 0)  >= 2 THEN 0.65  -- few sellers, no sales
        ELSE 0.55                                            -- single seller / unknown
      END AS haircut
    FROM latest l
    WHERE l.fmv_usd IS NOT NULL
      AND l.floor_price_usd IS NOT NULL
      AND COALESCE(l.sales_count_30d, 0) <= 2
      AND ABS(l.fmv_usd - l.floor_price_usd) < 0.01  -- fmv ≈ floor (within $0.01)
      AND l.confidence IN ('LOW','ASK_ONLY')
  ),
  to_apply AS (
    SELECT *,
      ROUND(old_fmv * haircut, 2) AS new_fmv
    FROM candidates
    WHERE haircut < 1.0
  )
  SELECT 
    (SELECT COUNT(*) FROM candidates),
    (SELECT COUNT(*) FROM to_apply),
    (SELECT COALESCE(SUM(old_fmv - new_fmv), 0) FROM to_apply)
  INTO v_examined, v_haircut, v_dollars;

  IF NOT p_dry_run THEN
    -- Apply: in-place UPDATE of fmv_usd (preserves history; floor_price stays as-is for transparency)
    WITH latest AS (
      SELECT DISTINCT ON (edition_id) id, edition_id, fmv_usd, floor_price_usd,
        sales_count_30d, listing_count, confidence
      FROM fmv_snapshots
      WHERE (p_collection_id IS NULL OR collection_id = p_collection_id)
      ORDER BY edition_id, computed_at DESC
    )
    UPDATE fmv_snapshots fs
    SET fmv_usd = ROUND(fs.fmv_usd *
      CASE
        WHEN COALESCE(fs.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(fs.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(fs.listing_count, 0)  >= 2 THEN 0.65
        ELSE 0.55
      END, 2),
      algo_version = fs.algo_version || '_haircut'
    FROM latest l
    WHERE fs.id = l.id
      AND fs.fmv_usd IS NOT NULL
      AND fs.floor_price_usd IS NOT NULL
      AND COALESCE(fs.sales_count_30d, 0) <= 2
      AND ABS(fs.fmv_usd - fs.floor_price_usd) < 0.01
      AND fs.confidence IN ('LOW','ASK_ONLY');
  END IF;

  RETURN QUERY SELECT v_examined, v_haircut, v_dollars;
END;
$function$;
