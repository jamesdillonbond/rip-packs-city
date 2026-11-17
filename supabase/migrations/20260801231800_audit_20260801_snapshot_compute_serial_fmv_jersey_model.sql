-- Snapshot migration: public.compute_serial_fmv_jersey_model(uuid,integer,integer,numeric).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01; byte-identical, md5
-- 390387b98701d1bce2ff1e65ea62d119) so it can carry a pinned invariant test.
-- Applying it is a no-op against prod.
--
-- What it does: the JERSEY-MATCH sibling of the power model. It fits a log-log
-- power curve price = k * fmv^beta over ONLY the sales whose serial number equals
-- the edition's jersey_number (jersey > 1, serial <> 1, serial <> circ) -- the
-- jersey-match premium -- again gated to HIGH/MEDIUM latest FMVs. Rows per tier +
-- an 'ALL' rollup over every qualifying sale. Its reliability ceiling is TIGHTER
-- than the power model's: is_reliable requires 0.15 < beta < 1.0 (not 1.25), since
-- a jersey premium should not scale super-linearly with FMV. Returns rows written.

CREATE OR REPLACE FUNCTION public.compute_serial_fmv_jersey_model(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, p_lookback_days integer DEFAULT 180, p_min_sample integer DEFAULT 40, p_min_r numeric DEFAULT 0.35)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE v_rows integer;
BEGIN
  DELETE FROM public.serial_fmv_jersey_model WHERE collection_id = p_collection_id;
  WITH latest_fmv AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd, fs.confidence::text AS confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = p_collection_id AND fs.computed_at > now() - interval '21 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  d AS (
    SELECT s.price_usd, lf.fmv_usd, e.tier::text AS tier
    FROM public.sales s
    JOIN public.editions e ON e.id = s.edition_id
    JOIN latest_fmv lf ON lf.edition_id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND s.sold_at > now() - make_interval(days => p_lookback_days)
      AND s.price_usd > 0 AND e.circulation_count > 0 AND lf.fmv_usd > 0
      AND lf.confidence IN ('HIGH','MEDIUM')
      AND e.jersey_number IS NOT NULL AND e.jersey_number > 1
      AND s.serial_number = e.jersey_number
      AND s.serial_number <> 1
      AND s.serial_number <> e.circulation_count
  ),
  fits AS (
    SELECT d.tier, exp(regr_intercept(ln(price_usd), ln(fmv_usd))) AS k, regr_slope(ln(price_usd), ln(fmv_usd)) AS beta,
      count(*)::int AS n, corr(ln(price_usd), ln(fmv_usd)) AS r, min(fmv_usd) AS fmv_min, max(fmv_usd) AS fmv_max
    FROM d WHERE d.tier IS NOT NULL GROUP BY d.tier
    UNION ALL
    SELECT 'ALL', exp(regr_intercept(ln(price_usd), ln(fmv_usd))), regr_slope(ln(price_usd), ln(fmv_usd)),
      count(*)::int, corr(ln(price_usd), ln(fmv_usd)), min(fmv_usd), max(fmv_usd)
    FROM d
  )
  INSERT INTO public.serial_fmv_jersey_model (collection_id, tier, k, beta, sample_size, r, fmv_min, fmv_max, is_reliable, computed_at)
  SELECT p_collection_id, f.tier, round(f.k::numeric,4), round(f.beta::numeric,4), f.n, round(f.r::numeric,3),
    round(f.fmv_min::numeric,2), round(f.fmv_max::numeric,2),
    (f.n >= p_min_sample AND f.r >= p_min_r AND f.beta > 0.15 AND f.beta < 1.0), now()
  FROM fits f WHERE f.k IS NOT NULL AND f.beta IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT; RETURN v_rows;
END;
$function$;
