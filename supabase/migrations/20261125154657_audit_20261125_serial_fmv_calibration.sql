-- 2026-11-25 special-serial FMV calibration (serial-cal-1.0).
-- Why: every serial model (power, jersey, pooled) is fit against the edition's CURRENT FMV, not the FMV
-- when the special serial sold. Edition FMVs fell (a June sale's edition is now ~0.47x its June price), so
-- price/fmv_now overstates the premium. Out of sample, the published estimate ran above the realised sale
-- in 24 of 24 bucket-months (Top Shot Apr-Nov 2026): #1 1.10-1.46x, jersey 1.19-2.12x, perfect 1.15-1.54x.
-- Walk-forward test (factor from sales 165-45 d ago, applied to the last 45 d, n 446):
--   #1      within +/-25 19.7 -> 27.2, within +/-50 42.9 -> 54.4, median ratio 1.41 -> 1.07, WAPE 0.56 -> 0.58
--   jersey  14.5 -> 27.5, 32.1 -> 47.3, 1.72 -> 1.12, WAPE 0.71 -> 0.69
--   perfect 25.0 -> 30.4, 45.2 -> 60.1, 1.49 -> 1.10, WAPE 0.49 -> 0.49
-- Change: the model body is renamed serial_fmv_estimate_uncalibrated; serial_fmv_estimate (8-arg) divides its
-- estimate by a per collection x bucket factor = exp(median ln(est/sale) shrunk n/(n+20)), clamped [0.5, 2.5],
-- refreshed weekly from the last 90 days (FMV in force >= 1 day before the sale, HIGH/MEDIUM only).
-- The floor at the edition FMV is kept. Revert: rename the _uncalibrated function back over the wrapper
-- (handoff claude/handoff-2026-11-25-pricing-deep-pass.md has the exact statements).

CREATE TABLE IF NOT EXISTS public.serial_fmv_calibration (
  collection_id uuid NOT NULL,
  serial_bucket text NOT NULL CHECK (serial_bucket IN ('first','perfect','jersey')),
  factor numeric NOT NULL,
  raw_median_bias numeric,
  n integer NOT NULL,
  window_days integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, serial_bucket)
);
ALTER TABLE public.serial_fmv_calibration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.serial_fmv_calibration FROM anon, authenticated;
COMMENT ON TABLE public.serial_fmv_calibration IS
 'serial-cal-1.0 (2026-11-25): divisor applied to serial_fmv_estimate per collection x bucket; refreshed weekly by refresh_serial_fmv_calibration().';

ALTER FUNCTION public.serial_fmv_estimate(uuid, integer, integer, text, numeric, text, integer, uuid)
  RENAME TO serial_fmv_estimate_uncalibrated;

CREATE FUNCTION public.serial_fmv_estimate(p_collection_id uuid, p_serial integer, p_circulation integer,
  p_tier text, p_edition_fmv numeric, p_confidence text, p_jersey_number integer, p_edition_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE r jsonb; v_f numeric; v_est numeric;
BEGIN
  r := public.serial_fmv_estimate_uncalibrated(p_collection_id, p_serial, p_circulation, p_tier,
         p_edition_fmv, p_confidence, p_jersey_number, p_edition_id);
  IF r IS NULL OR (r->>'estimate_usd') IS NULL THEN RETURN r; END IF;
  SELECT c.factor INTO v_f FROM public.serial_fmv_calibration c
   WHERE c.collection_id = p_collection_id AND c.serial_bucket = r->>'serial_bucket';
  IF v_f IS NULL OR v_f <= 0 OR v_f = 1 THEN RETURN r; END IF;
  v_est := GREATEST(p_edition_fmv, (r->>'estimate_usd')::numeric / v_f);
  RETURN r || jsonb_build_object('estimate_usd', round(v_est, 2),
     'multiplier', round(v_est / p_edition_fmv, 2),
     'uncalibrated_estimate_usd', (r->>'estimate_usd')::numeric,
     'calibration_factor', round(v_f, 3), 'calibration', 'serial-cal-1.0');
END;
$fn$;
REVOKE ALL ON FUNCTION public.serial_fmv_estimate(uuid, integer, integer, text, numeric, text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid, integer, integer, text, numeric, text, integer, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_serial_fmv_calibration(p_collection_id uuid,
  p_days integer DEFAULT 90, p_shrink_k integer DEFAULT 20)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $fn$
DECLARE v jsonb;
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
  RETURN v;
END;
$fn$;
REVOKE ALL ON FUNCTION public.refresh_serial_fmv_calibration(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_serial_fmv_calibration(uuid, integer, integer) TO service_role;