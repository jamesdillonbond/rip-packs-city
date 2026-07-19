-- DB invariant: public.fmv_clamp_disconnected_ask_topshot — the guard that pulls
-- an inflated LOW/ASK_ONLY Top Shot FMV back down to a sales-anchored level when
-- it has drifted far above the real 90-day sale distribution (the "$42/$170/$2924
-- disconnected ask" class). It clamps FMV to GREATEST(p90*1.5, median), tags the
-- snapshot's algo_version with `_p90clamp` (idempotently), and logs a pipeline
-- run; a dry-run counts without mutating. DDL below is a VERBATIM copy of the
-- committed migration
-- (supabase/migrations/20260702140000_audit_20260702_fmv_clamp_disconnected_ask_topshot.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins for the four tables the guard reads/writes.
CREATE TABLE editions (id uuid PRIMARY KEY, circulation_count int);
CREATE TABLE fmv_snapshots (
  id bigserial PRIMARY KEY, edition_id uuid, collection_id uuid,
  fmv_usd numeric, confidence text, algo_version text, computed_at timestamptz DEFAULT now());
CREATE TABLE sales (
  edition_id uuid, collection_id uuid, price_usd numeric, sold_at timestamptz);
CREATE TABLE pipeline_runs (
  id bigserial PRIMARY KEY, pipeline text, started_at timestamptz, finished_at timestamptz,
  ok boolean, extra jsonb);

-- >>> BEGIN verbatim fmv_clamp_disconnected_ask_topshot (byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask_topshot(p_dry_run boolean DEFAULT false)
RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  c_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  IF p_dry_run THEN
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = c_ts
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.collection_id = c_ts AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND ( (COALESCE(e.circulation_count,0) >= 1000 AND l.fmv_usd > s.p90 * 3)
              OR (l.fmv_usd > s.p90 * 8) )
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = c_ts
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.collection_id = c_ts AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND ( (COALESCE(e.circulation_count,0) >= 1000 AND l.fmv_usd > s.p90 * 3)
              OR (l.fmv_usd > s.p90 * 8) )
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    ),
    upd AS (
      UPDATE public.fmv_snapshots fs
      SET fmv_usd = t.new_fmv,
          algo_version = CASE WHEN RIGHT(COALESCE(fs.algo_version,''),9) = '_p90clamp'
                              THEN fs.algo_version
                              ELSE COALESCE(fs.algo_version,'') || '_p90clamp' END
      FROM targets t
      WHERE fs.id = t.snapshot_id
      RETURNING (t.old_fmv - t.new_fmv) AS delta
    )
    SELECT count(*), COALESCE(sum(delta), 0) INTO v_clamped, v_dollars FROM upd;
    v_examined := v_clamped;

    INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, extra)
    VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true,
            jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2)));
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;
-- <<< END verbatim fmv_clamp_disconnected_ask_topshot <<<

-- Fixtures. TS collection; p90 = med = 10 for every edition below (5 sales @ $10).
-- E1 high-circ, FMV $100 LOW  → clamped (circ>=1000 AND FMV > p90*3=30)
-- E2 low-circ,  FMV $50  LOW  → NOT clamped (low-circ needs FMV > p90*8=80)
-- E3 low-circ,  FMV $90  LOW  → clamped (FMV 90 > 80)
-- E4 high-circ, FMV $100 HIGH → NOT clamped (confidence not LOW/ASK_ONLY)
-- E5 high-circ, FMV $100 LOW, only 4 sales → NOT clamped (n_real < 5)
-- E6 high-circ, FMV $100 LOW, algo already '..._p90clamp' → clamped, tag NOT doubled
DO $seed$
DECLARE
  c uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  ids uuid[] := ARRAY[
    'e1111111-1111-1111-1111-111111111111','e2222222-2222-2222-2222-222222222222',
    'e3333333-3333-3333-3333-333333333333','e4444444-4444-4444-4444-444444444444',
    'e5555555-5555-5555-5555-555555555555','e6666666-6666-6666-6666-666666666666']::uuid[];
  circ int[] := ARRAY[2000,100,100,2000,2000,2000];
  fmv numeric[] := ARRAY[100,50,90,100,100,100];
  conf text[] := ARRAY['LOW','LOW','LOW','HIGH','LOW','LOW'];
  algo text[] := ARRAY['v2','v2','v2','v2','v2','v2_p90clamp'];
  nsales int[] := ARRAY[5,5,5,5,4,5];
  i int; k int;
BEGIN
  FOR i IN 1..array_length(ids,1) LOOP
    INSERT INTO editions VALUES (ids[i], circ[i]);
    INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version)
      VALUES (ids[i], c, fmv[i], conf[i], algo[i]);
    FOR k IN 1..nsales[i] LOOP
      INSERT INTO sales VALUES (ids[i], c, 10, now() - interval '10 days');
    END LOOP;
  END LOOP;
END $seed$;

-- ── dry-run: counts targets but mutates NOTHING ─────────────────────────────
SELECT _assert_eq((SELECT rows_clamped::text FROM fmv_clamp_disconnected_ask_topshot(true)),
  '3', 'dry-run counts the 3 disconnected targets');
SELECT _assert_eq((SELECT count(*)::text FROM pipeline_runs), '0', 'dry-run writes no pipeline_runs row');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e1111111-1111-1111-1111-111111111111'),
  '100', 'dry-run leaves FMV untouched');

-- ── real run: clamps + returns dollars removed = (100-15)+(90-15)+(100-15) ───
SELECT _assert_eq((SELECT dollars_removed::text FROM fmv_clamp_disconnected_ask_topshot(false)),
  '245.00', 'real run removes $245 across the 3 targets');

-- clamped targets → GREATEST(p90*1.5=15, med=10) = 15
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e1111111-1111-1111-1111-111111111111'),
  '15.00', 'high-circ 3x-disconnected clamped to 15');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e3333333-3333-3333-3333-333333333333'),
  '15.00', 'low-circ 8x-disconnected clamped to 15');
-- algo_version tagging
SELECT _assert_eq((SELECT algo_version FROM fmv_snapshots WHERE edition_id = 'e1111111-1111-1111-1111-111111111111'),
  'v2_p90clamp', 'fresh snapshot gets _p90clamp appended');
SELECT _assert_eq((SELECT algo_version FROM fmv_snapshots WHERE edition_id = 'e6666666-6666-6666-6666-666666666666'),
  'v2_p90clamp', 'already-tagged snapshot is NOT double-appended');
-- non-targets untouched
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e2222222-2222-2222-2222-222222222222'),
  '50', 'low-circ under the 8x bar is left alone');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e4444444-4444-4444-4444-444444444444'),
  '100', 'HIGH-confidence FMV is never clamped');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e5555555-5555-5555-5555-555555555555'),
  '100', 'edition with < 5 real sales is left alone');
-- the real run logs exactly one pipeline_runs row
SELECT _assert_eq((SELECT count(*)::text FROM pipeline_runs WHERE pipeline = 'fmv-clamp-disconnected-ask'),
  '1', 'real run logs one pipeline_runs row');

SELECT '✓ fmv_clamp_disconnected_ask_topshot invariants pass' AS result;
ROLLBACK;
