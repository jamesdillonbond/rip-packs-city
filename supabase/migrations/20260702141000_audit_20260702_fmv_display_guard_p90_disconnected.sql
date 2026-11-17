-- Broaden the read-side display guard (topshot_fmv_display_guard) with the P1b
-- tiered "disconnected ASK" rule (same thresholds as fmv_clamp_disconnected_ask_topshot):
-- catches the bimodal fake-deal class the max_sale clamp misses (fmv sits BELOW a
-- lone outlier that inflated the WAP, so max is polluted; p90 of non-gift 90d sales
-- is the honest anchor). Consumed by lib/fmv-display-guard.ts on /api/market +
-- /api/sniper-feed. Refreshed daily by pg_cron 'rpc-refresh-fmv-display-guard' (45 13).
--
-- REVERT: restore refresh_topshot_fmv_display_guard() to its prior body (git
--         history) and:
--         ALTER TABLE public.topshot_fmv_display_guard
--           DROP COLUMN p90_90d, DROP COLUMN fmv_disconnected, DROP COLUMN clamp_target;
ALTER TABLE public.topshot_fmv_display_guard
  ADD COLUMN IF NOT EXISTS p90_90d numeric,
  ADD COLUMN IF NOT EXISTS fmv_disconnected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS clamp_target numeric;

CREATE OR REPLACE FUNCTION public.refresh_topshot_fmv_display_guard()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.topshot_fmv_display_guard;

  INSERT INTO public.topshot_fmv_display_guard
    (external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d,
     is_thin, fmv_exceeds_max, computed_at, p90_90d, fmv_disconnected, clamp_target)
  WITH s90 AS (
    SELECT s.edition_id,
           count(*)::integer AS n_90d,
           max(s.price_usd)::numeric AS max_sale_90d,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd))::numeric AS median_90d,
           count(*) FILTER (WHERE s.price_usd > 0.10)::integer AS n_real,
           (percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd)
              FILTER (WHERE s.price_usd > 0.10))::numeric AS p90_real,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)
              FILTER (WHERE s.price_usd > 0.10))::numeric AS med_real
    FROM public.sales s
    WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
    GROUP BY s.edition_id
  ),
  lf AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd::numeric AS fmv_usd, fs.confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND fs.computed_at > now() - interval '10 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  scored AS (
    SELECT e.external_id,
           e.id AS edition_id,
           lf.fmv_usd,
           s.max_sale_90d,
           s.median_90d,
           s.n_90d,
           s.p90_real,
           s.med_real,
           (s.n_90d < 15 AND s.median_90d > 0 AND lf.fmv_usd > 1.5 * s.median_90d) AS is_thin,
           (lf.fmv_usd > s.max_sale_90d) AS fmv_exceeds_max,
           (lf.confidence IN ('LOW','ASK_ONLY') AND s.n_real >= 5 AND s.p90_real > 0
             AND ( (COALESCE(e.circulation_count,0) >= 1000 AND lf.fmv_usd > s.p90_real * 3)
                   OR (lf.fmv_usd > s.p90_real * 8) )) AS fmv_disconnected
    FROM public.editions e
    JOIN s90 s ON s.edition_id = e.id
    JOIN lf   ON lf.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND e.external_id ~ '^[0-9]+:[0-9]+$'
      AND lf.fmv_usd > 0
  )
  SELECT external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d,
         is_thin, fmv_exceeds_max, now(), p90_real, fmv_disconnected,
         CASE WHEN fmv_disconnected
              THEN ROUND(GREATEST(p90_real * 1.5, med_real)::numeric, 2)
              ELSE NULL END AS clamp_target
  FROM scored
  WHERE fmv_exceeds_max OR is_thin OR fmv_disconnected;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
