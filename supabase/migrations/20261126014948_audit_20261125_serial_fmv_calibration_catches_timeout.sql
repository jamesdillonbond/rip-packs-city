-- anon-exec: intentional — snapshot re-create with the SAME signature preserves the revoked ACL (service_role only) (refresh_serial_fmv_calibration)
-- 2026-11-25: refresh_serial_fmv_calibration caught only WHEN OTHERS, which does not catch a statement_timeout
-- kill (57014, R118), so a killed Sunday run (pg_cron 928) would have logged nothing to pipeline_runs and the
-- watch would only see silence days later. It now names query_canceled, logs ok=false with the error, and
-- returns. Found by the new-plpgsql-recording-handlers-catch-query-canceled guard. Body otherwise unchanged.
CREATE OR REPLACE FUNCTION public.refresh_serial_fmv_calibration(p_collection_id uuid,
  p_days integer DEFAULT 90, p_shrink_k integer DEFAULT 20)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $fn$
DECLARE v jsonb; v_err text;
BEGIN
  BEGIN
    WITH s AS (
      SELECT sm.edition_id, sm.serial_number, sm.price_usd, sm.sold_at, e.circulation_count AS circ,
             e.tier::text AS tier, e.jersey_number::int AS j
        FROM public.sales_market sm JOIN public.editions e ON e.id = sm.edition_id
       WHERE sm.collection_id = p_collection_id
         AND sm.sold_at > now() - make_interval(days => p_days)
         AND sm.price_usd > 0 AND e.circulation_count > 1
         AND (p_collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
              OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
         AND (sm.serial_number = 1 OR sm.serial_number = e.circulation_count
              OR (e.jersey_number > 1 AND sm.serial_number = e.jersey_number))
    ), f AS (
      SELECT s.*, x.fmv_usd, x.confidence::text AS conf
        FROM s CROSS JOIN LATERAL (
          SELECT fs.fmv_usd, fs.confidence FROM public.fmv_snapshots fs
           WHERE fs.edition_id = s.edition_id AND fs.computed_at <= s.sold_at - interval '1 day'
           ORDER BY fs.computed_at DESC LIMIT 1) x
       WHERE x.confidence::text IN ('HIGH','MEDIUM') AND x.fmv_usd > 0
    ), p AS (
      SELECT public.serial_fmv_estimate_uncalibrated(p_collection_id, serial_number, circ, tier, fmv_usd,
               conf, j, edition_id) AS r, price_usd
        FROM f
    ), b AS (
      SELECT r->>'serial_bucket' AS bucket, count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ln((r->>'estimate_usd')::numeric / price_usd)) AS lb
        FROM p WHERE (r->>'estimate_usd') IS NOT NULL
       GROUP BY 1
    ), up AS (
      INSERT INTO public.serial_fmv_calibration AS c
        (collection_id, serial_bucket, factor, raw_median_bias, n, window_days, computed_at)
      SELECT p_collection_id, bucket,
             round(LEAST(2.5, GREATEST(0.5, exp(lb * n / (n + p_shrink_k))))::numeric, 4),
             round(exp(lb)::numeric, 4), n, p_days, now()
        FROM b WHERE bucket IN ('first','perfect','jersey')
      ON CONFLICT (collection_id, serial_bucket) DO UPDATE
        SET factor = EXCLUDED.factor, raw_median_bias = EXCLUDED.raw_median_bias, n = EXCLUDED.n,
            window_days = EXCLUDED.window_days, computed_at = EXCLUDED.computed_at
      RETURNING c.serial_bucket, c.factor, c.n
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', serial_bucket, 'factor', factor, 'n', n)), '[]'::jsonb)
      INTO v FROM up;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300); v := '[]'::jsonb;
  END;
  PERFORM public.log_pipeline_run('serial-fmv-calibration', v_err IS NULL AND jsonb_array_length(v) > 0,
    jsonb_build_object('collection_id', p_collection_id, 'buckets', v, 'error', v_err, 'via', 'pg_cron 928'));
  RETURN v;
END;
$fn$;