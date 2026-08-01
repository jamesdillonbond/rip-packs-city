-- DB invariant: public.compute_serial_fmv_power_model(uuid,integer,integer,numeric)
-- — the log-log POWER model price = k * fmv^beta for serial-1 ('first', per tier)
-- and serial=circ ('perfect', tier 'ALL') sales. Load-bearing invariants pinned:
--   * DELETE-then-recompute (a stale collection row is gone);
--   * the input gates that keep the fit honest: only HIGH/MEDIUM-confidence latest
--     FMVs feed it (a LOW-confidence outlier is excluded) and only serial=1 /
--     serial=circ sales qualify (a mid-serial outlier is excluded) -- both are
--     proven by the fit landing EXACTLY on the clean k/beta despite the outliers;
--   * the coefficient math: for a perfect price = 2*fmv relationship, k=2.0000,
--     beta=1.0000, r=1.000;
--   * the reliability gate is_reliable = (n >= p_min_sample AND r >= p_min_r AND
--     0.15 < beta < 1.25) -- tested at the sample boundary (a perfect r=1 fit is
--     still UNreliable when n < p_min_sample).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231700_audit_20260801_snapshot_compute_serial_fmv_power_model.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (62f59c6ecb62482d411c4f4d25de568b).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (id uuid PRIMARY KEY, tier text, circulation_count integer);
CREATE TABLE sales (edition_id uuid, serial_number integer, price_usd numeric, collection_id uuid, sold_at timestamptz);
CREATE TABLE fmv_snapshots (edition_id uuid, fmv_usd numeric, confidence text, collection_id uuid, computed_at timestamptz);
CREATE TABLE serial_fmv_power_model (
  collection_id uuid, serial_bucket text, tier text, k numeric, beta numeric,
  sample_size integer, r numeric, fmv_min numeric, fmv_max numeric,
  is_reliable boolean, computed_at timestamptz
);

-- >>> BEGIN verbatim compute_serial_fmv_power_model (keep byte-identical to the migration) >>>
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
-- <<< END verbatim compute_serial_fmv_power_model <<<

-- Collection under test (TopShot default uuid).
-- FIRST bucket (serial=1), tier RARE: 5 editions on a PERFECT price = 2*fmv line
-- (-> k=2, beta=1, r=1). circ=100 each so serial 1 != circ (unambiguously 'first').
INSERT INTO editions (id, tier, circulation_count) VALUES
  ('f1111111-1111-1111-1111-111111111111', 'RARE', 100),
  ('f2222222-2222-2222-2222-222222222222', 'RARE', 100),
  ('f3333333-3333-3333-3333-333333333333', 'RARE', 100),
  ('f4444444-4444-4444-4444-444444444444', 'RARE', 100),
  ('f5555555-5555-5555-5555-555555555555', 'RARE', 100),
  ('f6666666-6666-6666-6666-666666666666', 'RARE', 100),   -- LOW-confidence FMV -> excluded
-- PERFECT bucket (serial=circ=5), tier ignored (stored 'ALL'): 3 editions, price = 3*fmv.
  ('e1111111-1111-1111-1111-111111111111', 'LEGENDARY', 5),
  ('e2222222-2222-2222-2222-222222222222', 'LEGENDARY', 5),
  ('e3333333-3333-3333-3333-333333333333', 'LEGENDARY', 5);

-- latest FMV per edition (HIGH/MEDIUM feed the fit; the f6 one is LOW -> excluded)
INSERT INTO fmv_snapshots (edition_id, fmv_usd, confidence, collection_id, computed_at) VALUES
  ('f1111111-1111-1111-1111-111111111111', 10,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f2222222-2222-2222-2222-222222222222', 20,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f3333333-3333-3333-3333-333333333333', 40,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f4444444-4444-4444-4444-444444444444', 50,  'MEDIUM', '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f5555555-5555-5555-5555-555555555555', 100, 'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f6666666-6666-6666-6666-666666666666', 30,  'LOW',    '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- excluded by confidence gate
  ('e1111111-1111-1111-1111-111111111111', 10,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('e2222222-2222-2222-2222-222222222222', 20,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('e3333333-3333-3333-3333-333333333333', 40,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day');

-- serial-1 sales at price = 2*fmv (the clean 'first'/RARE fit)
INSERT INTO sales (edition_id, serial_number, price_usd, collection_id, sold_at) VALUES
  ('f1111111-1111-1111-1111-111111111111', 1, 20,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f2222222-2222-2222-2222-222222222222', 1, 40,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f3333333-3333-3333-3333-333333333333', 1, 80,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f4444444-4444-4444-4444-444444444444', 1, 100, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('f5555555-5555-5555-5555-555555555555', 1, 200, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  -- f6 serial-1 sale at a fit-wrecking price, but its FMV is LOW-confidence -> excluded
  ('f6666666-6666-6666-6666-666666666666', 1, 9999, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  -- a mid-serial sale on f1 at a fit-wrecking price -> excluded (serial != 1, != circ 100)
  ('f1111111-1111-1111-1111-111111111111', 50, 9999, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  -- serial=circ=5 sales at price = 3*fmv (the 'perfect' fit)
  ('e1111111-1111-1111-1111-111111111111', 5, 30,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('e2222222-2222-2222-2222-222222222222', 5, 60,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('e3333333-3333-3333-3333-333333333333', 5, 120, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day');

-- Stale prior row -> DELETE must remove it.
INSERT INTO serial_fmv_power_model (collection_id, serial_bucket, tier, k, beta, sample_size, r, fmv_min, fmv_max, is_reliable, computed_at)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'first', 'STALE', 9.9, 9.9, 999, 0.9, 1, 1, true, now() - interval '10 days');

-- Run: p_min_sample=4 (first has 5 -> reliable; perfect has 3 -> NOT), p_min_r=0.9.
SELECT _assert_eq(
  compute_serial_fmv_power_model('95f28a17-224a-4025-96ad-adf8a4c63bfd', 180, 4, 0.9)::text,
  '2', 'writes exactly 2 fit rows (first/RARE + perfect/ALL)');

-- 1) DELETE-then-recompute: the stale row is gone.
SELECT _assert_eq((SELECT count(*)::text FROM serial_fmv_power_model WHERE tier='STALE'), '0', 'the stale row was deleted before recompute');

-- 2) FIRST/RARE fit lands EXACTLY on k=2, beta=1, r=1 despite the LOW-confidence
--    and mid-serial outliers -> both input gates held.
SELECT _assert_eq((SELECT k::text     FROM serial_fmv_power_model WHERE serial_bucket='first' AND tier='RARE'), '2.0000', 'first/RARE k = 2 (LOW-conf + mid-serial 9999 outliers excluded)');
SELECT _assert_eq((SELECT beta::text  FROM serial_fmv_power_model WHERE serial_bucket='first' AND tier='RARE'), '1.0000', 'first/RARE beta = 1');
SELECT _assert_eq((SELECT r::text     FROM serial_fmv_power_model WHERE serial_bucket='first' AND tier='RARE'), '1.000',  'first/RARE r = 1 (perfect log-log fit)');
SELECT _assert_eq((SELECT sample_size::text FROM serial_fmv_power_model WHERE serial_bucket='first' AND tier='RARE'), '5', 'first/RARE n = 5 (the 6th LOW-conf row excluded)');
SELECT _assert_eq((SELECT (fmv_min::text||'/'||fmv_max::text) FROM serial_fmv_power_model WHERE serial_bucket='first' AND tier='RARE'), '10.00/100.00', 'first/RARE fmv range 10..100');

-- 3) reliability gate: first/RARE n=5 >= 4 -> reliable.
SELECT _assert_eq((SELECT is_reliable::text FROM serial_fmv_power_model WHERE serial_bucket='first' AND tier='RARE'), 'true', 'first/RARE reliable (n 5 >= 4, r 1 >= 0.9, beta 1 in range)');

-- 4) PERFECT/ALL fit k=3, beta=1, r=1; but n=3 < p_min_sample 4 -> NOT reliable
--    (proves the sample gate independently of r).
SELECT _assert_eq((SELECT (k::text||'/'||beta::text||'/'||sample_size::text) FROM serial_fmv_power_model WHERE serial_bucket='perfect'), '3.0000/1.0000/3', 'perfect/ALL k=3 beta=1 n=3');
SELECT _assert_eq((SELECT tier FROM serial_fmv_power_model WHERE serial_bucket='perfect'), 'ALL', 'perfect bucket tier forced to ALL');
SELECT _assert_eq((SELECT is_reliable::text FROM serial_fmv_power_model WHERE serial_bucket='perfect'), 'false', 'perfect/ALL NOT reliable: a perfect r=1 fit still fails the n>=4 gate');

SELECT '✓ compute_serial_fmv_power_model invariants pass' AS result;
ROLLBACK;
