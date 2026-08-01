-- DB invariant: public.compute_serial_fmv_jersey_model(uuid,integer,integer,numeric)
-- — the JERSEY-MATCH power model: a log-log fit price = k * fmv^beta over ONLY the
-- sales whose serial equals the edition's jersey_number (jersey>1, serial<>1,
-- serial<>circ). Load-bearing invariants pinned here:
--   * DELETE-then-recompute (a stale collection row is gone);
--   * the jersey-match qualification -- a non-jersey serial, a jersey=1 edition, a
--     serial=circ collision, and a LOW-confidence FMV are ALL excluded, proven by
--     the fit landing EXACTLY on the clean coefficients despite those outliers;
--   * the coefficient math on a perfect price = 10 * sqrt(fmv) curve: k=10.0000,
--     beta=0.5000, r=1.000;
--   * the TIGHTER reliability ceiling unique to the jersey model:
--     is_reliable requires beta < 1.0 (NOT 1.25) -- so a perfect r=1, ample-sample
--     beta=1.0 tier fit is still marked UNreliable, where the power model would
--     have accepted it.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231800_audit_20260801_snapshot_compute_serial_fmv_jersey_model.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (390387b98701d1bce2ff1e65ea62d119).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (id uuid PRIMARY KEY, tier text, circulation_count integer, jersey_number integer);
CREATE TABLE sales (edition_id uuid, serial_number integer, price_usd numeric, collection_id uuid, sold_at timestamptz);
CREATE TABLE fmv_snapshots (edition_id uuid, fmv_usd numeric, confidence text, collection_id uuid, computed_at timestamptz);
CREATE TABLE serial_fmv_jersey_model (
  collection_id uuid, tier text, k numeric, beta numeric, sample_size integer,
  r numeric, fmv_min numeric, fmv_max numeric, is_reliable boolean, computed_at timestamptz
);

-- >>> BEGIN verbatim compute_serial_fmv_jersey_model (keep byte-identical to the migration) >>>
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
-- <<< END verbatim compute_serial_fmv_jersey_model <<<

-- RARE tier: jersey number 7, circ 100. 5 jersey-match (serial=7) sales on a
-- PERFECT price = 10 * sqrt(fmv) curve (fmv are perfect squares) -> k=10, beta=0.5, r=1.
INSERT INTO editions (id, tier, circulation_count, jersey_number) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'RARE', 100, 7),
  ('a2222222-2222-2222-2222-222222222222', 'RARE', 100, 7),
  ('a3333333-3333-3333-3333-333333333333', 'RARE', 100, 7),
  ('a4444444-4444-4444-4444-444444444444', 'RARE', 100, 7),
  ('a5555555-5555-5555-5555-555555555555', 'RARE', 100, 7),
  ('a6666666-6666-6666-6666-666666666666', 'RARE', 100, 7),   -- LOW-confidence FMV -> excluded
  ('a7777777-7777-7777-7777-777777777777', 'RARE', 100, 1),   -- jersey_number = 1 -> excluded (jersey>1)
  ('a8888888-8888-8888-8888-888888888888', 'RARE',   7, 7),   -- jersey 7 == circ 7 -> excluded (serial<>circ)
-- LEGENDARY tier: jersey 9, circ 100. 4 jersey-match sales on price = 2*fmv (beta=1.0).
  ('b1111111-1111-1111-1111-111111111111', 'LEGENDARY', 100, 9),
  ('b2222222-2222-2222-2222-222222222222', 'LEGENDARY', 100, 9),
  ('b3333333-3333-3333-3333-333333333333', 'LEGENDARY', 100, 9),
  ('b4444444-4444-4444-4444-444444444444', 'LEGENDARY', 100, 9);

INSERT INTO fmv_snapshots (edition_id, fmv_usd, confidence, collection_id, computed_at) VALUES
  ('a1111111-1111-1111-1111-111111111111', 4,   'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('a2222222-2222-2222-2222-222222222222', 16,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('a3333333-3333-3333-3333-333333333333', 64,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('a4444444-4444-4444-4444-444444444444', 100, 'MEDIUM', '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('a5555555-5555-5555-5555-555555555555', 400, 'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('a6666666-6666-6666-6666-666666666666', 25,  'LOW',    '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- excluded by confidence
  ('a7777777-7777-7777-7777-777777777777', 50,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('a8888888-8888-8888-8888-888888888888', 50,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('b1111111-1111-1111-1111-111111111111', 10,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('b2222222-2222-2222-2222-222222222222', 20,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('b3333333-3333-3333-3333-333333333333', 40,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('b4444444-4444-4444-4444-444444444444', 50,  'HIGH',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day');

INSERT INTO sales (edition_id, serial_number, price_usd, collection_id, sold_at) VALUES
  -- RARE jersey-match (serial=7) at price = 10*sqrt(fmv)
  ('a1111111-1111-1111-1111-111111111111', 7, 20,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- 10*sqrt(4)
  ('a2222222-2222-2222-2222-222222222222', 7, 40,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- 10*sqrt(16)
  ('a3333333-3333-3333-3333-333333333333', 7, 80,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- 10*sqrt(64)
  ('a4444444-4444-4444-4444-444444444444', 7, 100, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- 10*sqrt(100)
  ('a5555555-5555-5555-5555-555555555555', 7, 200, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- 10*sqrt(400)
  -- excluded rows (all fit-wrecking prices; if any leaked the RARE fit would not be k=10/beta=0.5)
  ('a6666666-6666-6666-6666-666666666666', 7,  9999, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- LOW-conf fmv
  ('a1111111-1111-1111-1111-111111111111', 50, 9999, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- serial != jersey 7
  ('a7777777-7777-7777-7777-777777777777', 1,  9999, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- jersey=1 edition, serial 1
  ('a8888888-8888-8888-8888-888888888888', 7,  9999, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- serial 7 == circ 7
  -- LEGENDARY jersey-match (serial=9) at price = 2*fmv (beta=1.0)
  ('b1111111-1111-1111-1111-111111111111', 9, 20,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('b2222222-2222-2222-2222-222222222222', 9, 40,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('b3333333-3333-3333-3333-333333333333', 9, 80,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('b4444444-4444-4444-4444-444444444444', 9, 100, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day');

-- Stale prior row -> DELETE must remove it.
INSERT INTO serial_fmv_jersey_model (collection_id, tier, k, beta, sample_size, r, fmv_min, fmv_max, is_reliable, computed_at)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'STALE', 9.9, 9.9, 999, 0.9, 1, 1, true, now() - interval '10 days');

-- Run: p_min_sample=4 (both RARE n=5 and LEGENDARY n=4 clear it), p_min_r=0.9.
SELECT _assert_eq(
  compute_serial_fmv_jersey_model('95f28a17-224a-4025-96ad-adf8a4c63bfd', 180, 4, 0.9)::text,
  '3', 'writes 3 rows: RARE + LEGENDARY + ALL rollup');

-- 1) DELETE-then-recompute.
SELECT _assert_eq((SELECT count(*)::text FROM serial_fmv_jersey_model WHERE tier='STALE'), '0', 'the stale row was deleted before recompute');

-- 2) RARE jersey fit lands EXACTLY on k=10, beta=0.5, r=1 -> all four excluded
--    outliers (LOW-conf, non-jersey serial, jersey=1, serial=circ) held.
SELECT _assert_eq((SELECT k::text    FROM serial_fmv_jersey_model WHERE tier='RARE'), '10.0000', 'RARE k = 10 (all four non-qualifying outliers excluded)');
SELECT _assert_eq((SELECT beta::text FROM serial_fmv_jersey_model WHERE tier='RARE'), '0.5000',  'RARE beta = 0.5 (price = 10*sqrt(fmv))');
SELECT _assert_eq((SELECT r::text    FROM serial_fmv_jersey_model WHERE tier='RARE'), '1.000',   'RARE r = 1');
SELECT _assert_eq((SELECT sample_size::text FROM serial_fmv_jersey_model WHERE tier='RARE'), '5', 'RARE n = 5 jersey-match sales');
SELECT _assert_eq((SELECT is_reliable::text FROM serial_fmv_jersey_model WHERE tier='RARE'), 'true', 'RARE reliable (n5>=4, r1>=0.9, 0.15<beta 0.5<1.0)');

-- 3) LEGENDARY fit is a perfect r=1 line with beta=1.0 and ample n, yet is marked
--    UNRELIABLE by the jersey model''s TIGHTER beta<1.0 ceiling.
SELECT _assert_eq((SELECT (beta::text||'/'||r::text||'/'||sample_size::text) FROM serial_fmv_jersey_model WHERE tier='LEGENDARY'), '1.0000/1.000/4', 'LEGENDARY beta=1 r=1 n=4');
SELECT _assert_eq((SELECT is_reliable::text FROM serial_fmv_jersey_model WHERE tier='LEGENDARY'), 'false', 'LEGENDARY UNreliable: beta 1.0 fails the strict beta<1.0 jersey ceiling');

-- 4) the ALL rollup row exists (fit over every qualifying sale, both tiers).
SELECT _assert_eq((SELECT count(*)::text FROM serial_fmv_jersey_model WHERE tier='ALL'), '1', 'an ALL rollup row is written');

SELECT '✓ compute_serial_fmv_jersey_model invariants pass' AS result;
ROLLBACK;
