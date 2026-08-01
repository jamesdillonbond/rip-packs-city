-- DB invariant: public.compute_serial_fmv_multipliers(uuid,integer,numeric,integer)
-- — the serial-FMV premium-multiplier model. It DELETEs a collection's prior
-- multiplier rows then recomputes, from sale-price PREMIUMS (sale / that edition's
-- own median, gated on >=10 sales), one row per (serial_bucket, tier, circ_band)
-- plus an ('ALL','ALL') rollup per bucket. Load-bearing invariants pinned here:
--   * DELETE-then-recompute (stale rows for the collection are gone);
--   * the serial_bucket classification first / perfect / low / normal;
--   * the multiplier CLAMP = LEAST(GREATEST(median_premium, 1.0), p_cap) — never
--     below 1.0, never above the cap, while median_premium stays UNclamped;
--   * the per-edition HAVING count(*) >= 10 median gate (thin editions contribute
--     nothing);
--   * is_reliable = sample_size >= p_min_sample.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231500_audit_20260801_snapshot_compute_serial_fmv_multipliers.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (039c2a3fc8212dbd194a395bd416c634).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id                 uuid PRIMARY KEY,
  tier               text,
  circulation_count  integer
);

CREATE TABLE sales (
  edition_id     uuid,
  serial_number  integer,
  price_usd      numeric,
  collection_id  uuid,
  sold_at        timestamptz
);

CREATE TABLE serial_fmv_multipliers (
  collection_id   uuid     NOT NULL,
  serial_bucket   text     NOT NULL,
  tier            text     NOT NULL,
  circ_band       text     NOT NULL,
  sample_size     integer  NOT NULL,
  median_premium  numeric,
  multiplier      numeric  NOT NULL,
  is_reliable     boolean  NOT NULL,
  computed_at     timestamptz NOT NULL
);

-- >>> BEGIN verbatim compute_serial_fmv_multipliers (keep byte-identical to the migration) >>>
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
-- <<< END verbatim compute_serial_fmv_multipliers <<<

-- Collection under test (TopShot uuid, the function default).
-- ed1: circ=50 (band 'ultra'), tier RARE, 13 qualifying sales -> passes HAVING>=10.
--   median price = 100 (13 prices: 50, 100 x10, 200, 300 -> percentile_cont(0.5)=100).
--   premiums: first(serial=1)=300/100=3.0, perfect(serial=50)=200/100=2.0,
--             low(serial=5)=50/100=0.5, normal(serials 20-29)=100/100=1.0 (x10).
-- ed2: circ=200, tier LEGENDARY, only 3 sales -> excluded by HAVING>=10.
INSERT INTO editions (id, tier, circulation_count) VALUES
  ('11111111-1111-1111-1111-111111111111', 'RARE',      50),
  ('22222222-2222-2222-2222-222222222222', 'LEGENDARY', 200);

-- ed1 sales
INSERT INTO sales (edition_id, serial_number, price_usd, collection_id, sold_at)
SELECT '11111111-1111-1111-1111-111111111111', g, 100, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'
FROM generate_series(20, 29) g;  -- 10 normal sales at 100
INSERT INTO sales (edition_id, serial_number, price_usd, collection_id, sold_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 1,  300, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- first
  ('11111111-1111-1111-1111-111111111111', 50, 200, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),  -- perfect
  ('11111111-1111-1111-1111-111111111111', 5,  50,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day');  -- low

-- ed2: only 3 sales -> HAVING count(*)>=10 fails -> contributes nothing
INSERT INTO sales (edition_id, serial_number, price_usd, collection_id, sold_at) VALUES
  ('22222222-2222-2222-2222-222222222222', 1, 500, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('22222222-2222-2222-2222-222222222222', 2, 500, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day'),
  ('22222222-2222-2222-2222-222222222222', 3, 500, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day');

-- Stale prior row for this collection -> DELETE must remove it (recompute, not append).
INSERT INTO serial_fmv_multipliers
  (collection_id, serial_bucket, tier, circ_band, sample_size, median_premium, multiplier, is_reliable, computed_at)
VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'STALE', 'RARE', 'ultra', 999, 9.9, 9.9, true, now() - interval '10 days');

-- Run: p_min_sample=10 (only the 10-sale 'normal' bucket is reliable), p_cap=2.5
-- (caps 'first' 3.0 -> 2.5, floors 'low' 0.5 -> 1.0), lookback 180d.
SELECT _assert_eq(
  compute_serial_fmv_multipliers('95f28a17-224a-4025-96ad-adf8a4c63bfd', 10, 2.5, 180)::text,
  '8', 'returns 8 rows written (4 tier-groups + 4 ALL-rollups; ed2 excluded)');

-- 1) DELETE-then-recompute: the stale row is gone.
SELECT _assert_eq(
  (SELECT count(*)::text FROM serial_fmv_multipliers WHERE serial_bucket='STALE'),
  '0', 'the pre-existing stale row was deleted before recompute');

-- 2) Exactly 8 rows total for the collection.
SELECT _assert_eq(
  (SELECT count(*)::text FROM serial_fmv_multipliers WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'),
  '8', 'exactly 8 rows persisted');

-- 3) CAP: first-bucket premium 3.0 stores median_premium=3.0 but multiplier clamps to the 2.5 cap.
SELECT _assert_eq(
  (SELECT median_premium::text FROM serial_fmv_multipliers WHERE serial_bucket='first' AND tier='RARE' AND circ_band='ultra'),
  '3.0000', 'first-bucket median_premium is the uncapped 3.0');
SELECT _assert_eq(
  (SELECT (multiplier = 2.5)::text FROM serial_fmv_multipliers WHERE serial_bucket='first' AND tier='RARE' AND circ_band='ultra'),
  'true', 'first-bucket multiplier is clamped down to the p_cap of 2.5');

-- 4) FLOOR: low-bucket premium 0.5 stores median_premium=0.5 but multiplier floors to 1.0.
SELECT _assert_eq(
  (SELECT median_premium::text FROM serial_fmv_multipliers WHERE serial_bucket='low' AND tier='RARE' AND circ_band='ultra'),
  '0.5000', 'low-bucket median_premium is the true 0.5');
SELECT _assert_eq(
  (SELECT (multiplier = 1.0)::text FROM serial_fmv_multipliers WHERE serial_bucket='low' AND tier='RARE' AND circ_band='ultra'),
  'true', 'low-bucket multiplier floors at 1.0 (never below 1.0)');

-- 5) perfect-bucket passes through untouched (1.0 <= 2.0 <= 2.5).
SELECT _assert_eq(
  (SELECT (multiplier = 2.0)::text FROM serial_fmv_multipliers WHERE serial_bucket='perfect' AND tier='RARE' AND circ_band='ultra'),
  'true', 'perfect-bucket multiplier passes through at 2.0');

-- 6) circ_band classification: circ=50 -> 'ultra'.
SELECT _assert_eq(
  (SELECT count(*)::text FROM serial_fmv_multipliers WHERE circ_band='ultra' AND tier='RARE'),
  '4', 'all 4 tier-scoped rows land in the ultra circ_band (circ 50 < 100)');

-- 7) is_reliable boundary: normal has 10 samples (>= p_min_sample 10 -> reliable);
--    first has 1 sample (-> not reliable).
SELECT _assert_eq(
  (SELECT (sample_size::text || '/' || is_reliable::text) FROM serial_fmv_multipliers WHERE serial_bucket='normal' AND tier='RARE' AND circ_band='ultra'),
  '10/true', 'normal bucket has 10 samples and is reliable');
SELECT _assert_eq(
  (SELECT (sample_size::text || '/' || is_reliable::text) FROM serial_fmv_multipliers WHERE serial_bucket='first' AND tier='RARE' AND circ_band='ultra'),
  '1/false', 'first bucket has 1 sample and is not reliable at p_min_sample=10');

-- 8) ('ALL','ALL') rollup exists per bucket (4 rollup rows), and mirrors the clamp.
SELECT _assert_eq(
  (SELECT count(*)::text FROM serial_fmv_multipliers WHERE tier='ALL' AND circ_band='ALL'),
  '4', 'one ALL/ALL rollup row per serial_bucket');
SELECT _assert_eq(
  (SELECT (multiplier = 2.5)::text FROM serial_fmv_multipliers WHERE serial_bucket='first' AND tier='ALL' AND circ_band='ALL'),
  'true', 'the ALL rollup for first is also capped at 2.5');

-- 9) ed2 (only 3 sales) contributed nothing: no LEGENDARY rows anywhere.
SELECT _assert_eq(
  (SELECT count(*)::text FROM serial_fmv_multipliers WHERE tier='LEGENDARY'),
  '0', 'the sub-10-sale edition is excluded by the HAVING count(*)>=10 gate');

SELECT '✓ compute_serial_fmv_multipliers invariants pass' AS result;
ROLLBACK;
