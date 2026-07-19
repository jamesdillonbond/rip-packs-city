-- DB invariant: public.compute_pack_ev_per_edition_weighted — the pack-EV pricing
-- core. It computes a pack's per-slot EV as the drop_weight-weighted mean of its
-- editions' FMVs, over the ORIGINAL mint-time pool when available else the
-- survivor-biased REMAINING pool, and REFUSES to price a Top Shot pack whose
-- remaining pool has collapsed to a single drop_weight (the chase-bias guard that
-- stopped $0/fabricated EVs). DDL below is a VERBATIM copy of the committed
-- migration
-- (supabase/migrations/20260707142744_audit_20260707_compute_pack_ev_require_varied_remaining_pool_ts.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- fmv_current is a view in prod (latest FMV per edition); the function only LEFT
-- JOINs it on (edition_id, collection_id, fmv_usd), so a plain table stands in.
CREATE TABLE pack_drop_pool (
  collection_id uuid, dist_id text, edition_id uuid,
  drop_weight numeric, orig_drop_weight numeric);
CREATE TABLE fmv_current (edition_id uuid, collection_id uuid, fmv_usd numeric);

-- >>> BEGIN verbatim compute_pack_ev_per_edition_weighted (byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.compute_pack_ev_per_edition_weighted(p_collection_id uuid, p_dist_id text, p_pack_price numeric, p_slots integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_edition_count           int;
  v_editions_with_fmv       int;
  v_per_slot_ev             numeric;
  v_total_weight            numeric;
  v_covered_weight          numeric;
  v_weighted_coverage_pct   smallint;
  v_unweighted_coverage_pct smallint;
  v_gross_ev                numeric;
  v_pack_ev                 numeric;
  v_value_ratio             numeric;
  v_use_original            boolean;
  v_basis                   text;
BEGIN
  IF p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND (SELECT count(DISTINCT drop_weight) FROM pack_drop_pool
          WHERE collection_id = p_collection_id AND dist_id = p_dist_id AND drop_weight > 0) <= 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_varied_remaining_pool', 'dist_id', p_dist_id);
  END IF;

  SELECT bool_or(orig_drop_weight IS NOT NULL) INTO v_use_original
  FROM pack_drop_pool
  WHERE collection_id = p_collection_id AND dist_id = p_dist_id;
  v_use_original := COALESCE(v_use_original, false);
  v_basis := CASE WHEN v_use_original THEN 'original' ELSE 'remaining' END;

  SELECT count(*),
         COALESCE(sum(CASE WHEN v_use_original THEN COALESCE(orig_drop_weight, 0) ELSE drop_weight END), 0)
    INTO v_edition_count, v_total_weight
  FROM pack_drop_pool pdp
  WHERE pdp.collection_id = p_collection_id AND pdp.dist_id = p_dist_id;

  IF v_edition_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_empty', 'dist_id', p_dist_id);
  END IF;
  IF v_total_weight = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'zero_total_weight', 'dist_id', p_dist_id);
  END IF;

  WITH pool AS (
    SELECT
      CASE WHEN v_use_original THEN COALESCE(pdp.orig_drop_weight, 0) ELSE pdp.drop_weight END AS w,
      fc.fmv_usd
    FROM pack_drop_pool pdp
    LEFT JOIN fmv_current fc
      ON fc.edition_id = pdp.edition_id
      AND fc.collection_id = pdp.collection_id
    WHERE pdp.collection_id = p_collection_id
      AND pdp.dist_id = p_dist_id
  )
  SELECT
    sum(w * fmv_usd) FILTER (WHERE fmv_usd IS NOT NULL)
      / NULLIF(sum(w) FILTER (WHERE fmv_usd IS NOT NULL), 0),
    count(*) FILTER (WHERE fmv_usd IS NOT NULL),
    sum(w) FILTER (WHERE fmv_usd IS NOT NULL)
  INTO v_per_slot_ev, v_editions_with_fmv, v_covered_weight
  FROM pool;

  IF v_editions_with_fmv = 0 OR v_per_slot_ev IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_fmv_coverage', 'dist_id', p_dist_id);
  END IF;

  v_weighted_coverage_pct   := (100.0 * v_covered_weight / v_total_weight)::smallint;
  v_unweighted_coverage_pct := (100.0 * v_editions_with_fmv / v_edition_count)::smallint;

  v_gross_ev := round((v_per_slot_ev * GREATEST(p_slots, 1))::numeric, 2);
  v_pack_ev  := round((v_gross_ev - COALESCE(p_pack_price, 0))::numeric, 2);
  v_value_ratio := CASE WHEN p_pack_price > 0
    THEN round((v_gross_ev / p_pack_price)::numeric, 3)
    ELSE NULL END;

  v_pack_ev  := GREATEST(LEAST(v_pack_ev, 1000000), -10000);
  v_gross_ev := GREATEST(LEAST(v_gross_ev, 1000000), -10000);

  RETURN jsonb_build_object(
    'ok', true,
    'gross_ev', v_gross_ev,
    'pack_ev', v_pack_ev,
    'value_ratio', v_value_ratio,
    'is_positive_ev', v_pack_ev > 0,
    'edition_count', v_edition_count,
    'editions_with_fmv', v_editions_with_fmv,
    'fmv_coverage_pct', v_unweighted_coverage_pct,
    'weighted_fmv_coverage_pct', v_weighted_coverage_pct,
    'per_edition_weighted', true,
    'ev_basis', v_basis,
    'total_pool_weight', round(v_total_weight, 4),
    'covered_pool_weight', round(v_covered_weight, 4)
  );
END;
$function$;
-- <<< END verbatim compute_pack_ev_per_edition_weighted <<<

-- Constants
--   TS   = the Top Shot collection (the only one the chase-bias guard applies to)
--   OTHER= any non-TS collection (guard does not apply)
DO $seed$
DECLARE
  ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  other uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  eA uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  eB uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  eC uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
BEGIN
  -- fmv_current is a CURRENT view: exactly one row per (edition, collection).
  -- eA=$10, eB=$100 on TS; eA=$10, eB=$20 on OTHER; eC has no FMV anywhere.
  INSERT INTO fmv_current VALUES (eA,ts,10),(eB,ts,100),(eA,other,10),(eB,other,20);

  -- D1 (TS, remaining basis): varied weights 0.9/0.1/0.5; A+B priced, C unpriced.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight, orig_drop_weight) VALUES
    (ts,'D1',eA,0.9,NULL),(ts,'D1',eB,0.1,NULL),(ts,'D1',eC,0.5,NULL);

  -- D2 (TS): uniform weight → chase-bias guard must refuse.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (ts,'D2',eA,0.5),(ts,'D2',eB,0.5);

  -- D3 (OTHER): uniform weight → guard does NOT apply, so it still prices.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (other,'D3',eA,0.5),(other,'D3',eB,0.5);

  -- D4 (TS): varied weights but NO FMV coverage (eC only, which has no FMV row).
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (ts,'D4',eC,0.9),(ts,'D4',eC,0.1);

  -- D5 (TS, original basis): orig weights 0.8/0.2 drive the mean; drop weights vary.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight, orig_drop_weight) VALUES
    (ts,'D5',eA,0.2,0.8),(ts,'D5',eB,0.8,0.2);
END $seed$;

-- ── happy path (remaining basis): weighted mean = (0.9*10 + 0.1*100)/1.0 = 19 ──
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'ok'),
  'true', 'D1 prices ok');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'gross_ev'),
  '19.00', 'D1 per-slot weighted mean = 19');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'pack_ev'),
  '9.00', 'D1 pack_ev = 19 - 10');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'value_ratio'),
  '1.900', 'D1 value_ratio = 19/10');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'is_positive_ev'),
  'true', 'D1 is +EV');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'edition_count'),
  '3', 'D1 counts all 3 editions');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'editions_with_fmv'),
  '2', 'D1 has FMV for 2 of 3');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'ev_basis'),
  'remaining', 'D1 uses the remaining pool');

-- slots multiplier: gross = per_slot * slots
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,2)->>'gross_ev'),
  '38.00', 'D1 with 2 slots doubles gross EV');

-- ── chase-bias guard: TS single-drop_weight pool is refused ──────────────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D2',10,1)->>'ok'),
  'false', 'D2 uniform-weight TS pool is refused');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D2',10,1)->>'reason'),
  'no_varied_remaining_pool', 'D2 refusal reason');

-- ── the guard is TS-only: a non-TS uniform pool still prices ─────────────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('dee28451-5d62-409e-a1ad-a83f763ac070','D3',10,1)->>'ok'),
  'true', 'D3 non-TS uniform pool is NOT blocked');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('dee28451-5d62-409e-a1ad-a83f763ac070','D3',10,1)->>'gross_ev'),
  '15.00', 'D3 mean = (0.5*10 + 0.5*20)/1.0 = 15');

-- ── no FMV coverage → refused ────────────────────────────────────────────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D4',10,1)->>'reason'),
  'no_fmv_coverage', 'D4 varied pool but no FMV → refused');

-- ── empty pool → refused. Use a non-TS collection: for TS the chase-bias guard
--    fires first (an empty pool has 0 distinct weights, which is <= 1). ─────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('dee28451-5d62-409e-a1ad-a83f763ac070','NOPE',10,1)->>'reason'),
  'pool_empty', 'unknown dist → pool_empty (non-TS, past the chase-bias guard)');

-- ── original basis: orig weights 0.8/0.2 → mean = (0.8*10 + 0.2*100)/1.0 = 28 ─
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D5',10,1)->>'ev_basis'),
  'original', 'D5 uses the original pool');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D5',10,1)->>'gross_ev'),
  '28.00', 'D5 original-weighted mean = 28');

SELECT '✓ compute_pack_ev_per_edition_weighted invariants pass' AS result;
ROLLBACK;
