-- Snapshot migration: public.compute_serial_fmv_power_model(uuid,integer,integer,numeric).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01; byte-identical, md5
-- 62f59c6ecb62482d411c4f4d25de568b) so it can carry a pinned invariant test.
-- Applying it is a no-op against prod.
--
-- What it does: fits a log-log POWER model price = k * fmv^beta over serial-1
-- ('first', grouped by tier) and serial=circ ('perfect', tier 'ALL') sales, using
-- ONLY editions whose latest (21d) fmv_snapshot is HIGH/MEDIUM confidence and > 0.
-- It DELETEs the collection's prior rows, recomputes k=exp(regr_intercept), beta=
-- regr_slope, r=corr over (ln price, ln fmv), and marks is_reliable only when
-- sample_size >= p_min_sample AND r >= p_min_r AND 0.15 < beta < 1.25. Returns the
-- number of fit rows written.

CREATE OR REPLACE FUNCTION public.compute_serial_fmv_power_model(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, p_lookback_days integer DEFAULT 180, p_min_sample integer DEFAULT 40, p_min_r numeric DEFAULT 0.35)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE v_rows integer;
BEGIN
  DELETE FROM public.serial_fmv_power_model WHERE collection_id = p_collection_id;
  WITH latest_fmv AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd, fs.confidence::text AS confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = p_collection_id
      AND fs.computed_at > now() - interval '21 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  d AS (
    SELECT s.price_usd, lf.fmv_usd,
      CASE WHEN s.serial_number = 1 THEN 'first'
           WHEN s.serial_number = e.circulation_count THEN 'perfect' END AS bucket,
      e.tier::text AS tier
    FROM public.sales s
    JOIN public.editions e ON e.id = s.edition_id
    JOIN latest_fmv lf ON lf.edition_id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND s.sold_at > now() - make_interval(days => p_lookback_days)
      AND s.price_usd > 0 AND e.circulation_count > 0 AND lf.fmv_usd > 0
      AND lf.confidence IN ('HIGH','MEDIUM')
      AND (s.serial_number = 1 OR s.serial_number = e.circulation_count)
  ),
  fits AS (
    SELECT 'first'::text AS serial_bucket, d.tier,
      exp(regr_intercept(ln(price_usd), ln(fmv_usd))) AS k,
      regr_slope(ln(price_usd), ln(fmv_usd)) AS beta,
      count(*)::int AS n, corr(ln(price_usd), ln(fmv_usd)) AS r,
      min(fmv_usd) AS fmv_min, max(fmv_usd) AS fmv_max
    FROM d WHERE d.bucket = 'first' AND d.tier IS NOT NULL GROUP BY d.tier
    UNION ALL
    SELECT 'perfect', 'ALL',
      exp(regr_intercept(ln(price_usd), ln(fmv_usd))),
      regr_slope(ln(price_usd), ln(fmv_usd)),
      count(*)::int, corr(ln(price_usd), ln(fmv_usd)),
      min(fmv_usd), max(fmv_usd)
    FROM d WHERE d.bucket = 'perfect'
  )
  INSERT INTO public.serial_fmv_power_model
    (collection_id, serial_bucket, tier, k, beta, sample_size, r, fmv_min, fmv_max, is_reliable, computed_at)
  SELECT p_collection_id, f.serial_bucket, f.tier,
    round(f.k::numeric,4), round(f.beta::numeric,4), f.n, round(f.r::numeric,3),
    round(f.fmv_min::numeric,2), round(f.fmv_max::numeric,2),
    (f.n >= p_min_sample AND f.r >= p_min_r AND f.beta > 0.15 AND f.beta < 1.25),
    now()
  FROM fits f WHERE f.k IS NOT NULL AND f.beta IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;
