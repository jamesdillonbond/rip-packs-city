-- Snapshot migration: public.compute_serial_fmv_multipliers(uuid,integer,numeric,integer).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01; byte-identical, md5
-- 039c2a3fc8212dbd194a395bd416c634) so it can carry a pinned invariant test.
-- Applying it is a no-op against prod.
--
-- What it does: the serial-FMV premium-multiplier model. For a collection it
-- DELETEs the prior serial_fmv_multipliers rows and recomputes, from >=180d of
-- sales, the median price PREMIUM (sale price / that edition's median) bucketed by
-- serial_bucket (first serial=1 / perfect serial=circ / low serial 2-10 / normal),
-- tier, and circ_band (ultra<100 / low<500 / mid<2500 / high<10000 / mass). It
-- gates each edition's own median on HAVING count>=10 sales, writes one row per
-- (bucket,tier,circ_band) PLUS an ('ALL','ALL') rollup per bucket, and CLAMPS the
-- stored multiplier to LEAST(GREATEST(median_premium, 1.0), p_cap) -- i.e. never
-- below 1.0, never above the cap. is_reliable = sample_size >= p_min_sample.
-- Returns the number of rows written.

CREATE OR REPLACE FUNCTION public.compute_serial_fmv_multipliers(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, p_min_sample integer DEFAULT 8, p_cap numeric DEFAULT 60.0, p_lookback_days integer DEFAULT 180)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE v_rows integer;
BEGIN
  DELETE FROM public.serial_fmv_multipliers WHERE collection_id = p_collection_id;
  WITH ed_sales AS (
    SELECT s.edition_id, s.serial_number, s.price_usd, coalesce(e.tier::text,'UNKNOWN') AS tier, e.circulation_count AS circ
    FROM public.sales s JOIN public.editions e ON e.id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND s.sold_at > now() - make_interval(days => p_lookback_days)
      AND s.price_usd > 0 AND s.serial_number IS NOT NULL AND e.circulation_count > 0
  ),
  ed_median AS (
    SELECT edition_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd) AS med
    FROM ed_sales GROUP BY edition_id HAVING count(*) >= 10
  ),
  premiums AS (
    SELECT es.price_usd / em.med AS premium,
      CASE WHEN es.serial_number=1 THEN 'first' WHEN es.serial_number=es.circ THEN 'perfect'
           WHEN es.serial_number BETWEEN 2 AND 10 THEN 'low' ELSE 'normal' END AS bucket,
      es.tier,
      CASE WHEN es.circ<100 THEN 'ultra' WHEN es.circ<500 THEN 'low' WHEN es.circ<2500 THEN 'mid'
           WHEN es.circ<10000 THEN 'high' ELSE 'mass' END AS circ_band
    FROM ed_sales es JOIN ed_median em ON em.edition_id = es.edition_id
  ),
  ins AS (
    INSERT INTO public.serial_fmv_multipliers
      (collection_id, serial_bucket, tier, circ_band, sample_size, median_premium, multiplier, is_reliable, computed_at)
    SELECT p_collection_id, bucket, tier, circ_band, count(*),
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY premium)::numeric,4),
      LEAST(GREATEST(percentile_cont(0.5) WITHIN GROUP (ORDER BY premium),1.0),p_cap),
      count(*) >= p_min_sample, now()
    FROM premiums GROUP BY bucket, tier, circ_band
    UNION ALL
    SELECT p_collection_id, bucket, 'ALL','ALL', count(*),
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY premium)::numeric,4),
      LEAST(GREATEST(percentile_cont(0.5) WITHIN GROUP (ORDER BY premium),1.0),p_cap),
      count(*) >= p_min_sample, now()
    FROM premiums GROUP BY bucket
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;
  RETURN v_rows;
END;
$function$;
