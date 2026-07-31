-- DB invariant: public.fmv_clamp_disconnected_ask_topshot — the guard that pulls
-- an inflated LOW/ASK_ONLY Top Shot FMV back down to a sales-anchored level when
-- it has drifted far above the real 90-day sale distribution (the "$42/$170/$2924
-- disconnected ask" class). It clamps FMV to GREATEST(p90*1.5, median), tags the
-- snapshot's algo_version with `_p90clamp` (idempotently), and logs a pipeline
-- run ONLY when it actually clamped something; a dry-run counts without mutating.
--
-- REPINNED 2026-07-31. This test previously embedded the 2026-07-02 14:45 copy of
-- the function, whose selection predicate was circulation-gated
--     (circulation_count >= 1000 AND fmv > p90*3) OR fmv > p90*8
-- while production has run a circulation-AGNOSTIC two-gate predicate
--     fmv > med*3 AND fmv > p90*1.5
-- since 2026-07-02 16:54 — about two hours later the same day. The pin was
-- therefore stale from the day it was written, and could not be caught from the
-- repo alone (the repo carries exactly ONE migration defining this function; the
-- rewrite was MCP-applied and never committed). See
-- supabase/migrations/20260731210000_audit_20260731_snapshot_stale_pin_ddl_fmv_clamp_and_pack_ev.sql.
--
-- DDL below is a VERBATIM copy of that snapshot migration;
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
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
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
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
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

    IF v_clamped > 0 THEN
      INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, extra)
      VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true,
              jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2)));
    END IF;
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;
-- <<< END verbatim fmv_clamp_disconnected_ask_topshot <<<

-- Fixtures. Two sale shapes, chosen so the two gates can be exercised INDEPENDENTLY
-- (a single flat distribution collapses them, which is how the old fixture set
-- managed to look thorough while never separating med*3 from p90*1.5):
--
--   FLAT  5 sales @ $10           → med 10, p90 10 → med*3 = 30, p90*1.5 = 15, clamp floor 15.00
--   SKEW  4 @ $10 + 1 @ $100      → med 10, p90 64 → med*3 = 30, p90*1.5 = 96, clamp floor 96.00
--
-- E1 FLAT circ 2000, FMV 100 LOW      → CLAMPED to 15.00  (both gates pass)
-- E2 FLAT circ 2000, FMV  20 LOW      → NOT clamped: 20 > p90*1.5 (15) but NOT > med*3 (30)
--                                        — pins that the MEDIAN gate really binds
-- E3 SKEW circ 2000, FMV  50 LOW      → NOT clamped: 50 > med*3 (30) but NOT > p90*1.5 (96)
--                                        — pins that the P90 gate really binds
-- E4 FLAT circ 2000, FMV 100 HIGH     → NOT clamped (confidence outside LOW/ASK_ONLY)
-- E5 FLAT circ 2000, FMV 100 LOW, 4 sales → NOT clamped (n_real < 5)
-- E6 FLAT circ 2000, FMV 100 LOW, algo already '..._p90clamp' → CLAMPED, tag NOT doubled
-- E7 SKEW circ 2000, FMV 200 LOW      → CLAMPED to 96.00 (floor follows p90*1.5, not med)
-- E8 FLAT circ  100, FMV  50 ASK_ONLY → CLAMPED to 15.00. This row is the
--    discriminator against the superseded predicate: with circulation 100 the old
--    rule required FMV > p90*8 = 80, so it left this row alone; the live rule
--    ignores circulation entirely and clamps it.
DO $seed$
DECLARE
  c uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  ids uuid[] := ARRAY[
    'e1111111-1111-1111-1111-111111111111','e2222222-2222-2222-2222-222222222222',
    'e3333333-3333-3333-3333-333333333333','e4444444-4444-4444-4444-444444444444',
    'e5555555-5555-5555-5555-555555555555','e6666666-6666-6666-6666-666666666666',
    'e7777777-7777-7777-7777-777777777777','e8888888-8888-8888-8888-888888888888']::uuid[];
  circ  int[]     := ARRAY[2000,2000,2000,2000,2000,2000,2000,100];
  fmv   numeric[] := ARRAY[100,20,50,100,100,100,200,50];
  conf  text[]    := ARRAY['LOW','LOW','LOW','HIGH','LOW','LOW','LOW','ASK_ONLY'];
  algo  text[]    := ARRAY['v2','v2','v2','v2','v2','v2_p90clamp','v2','v2'];
  nsales int[]    := ARRAY[5,5,5,5,4,5,5,5];
  skewed bool[]   := ARRAY[false,false,true,false,false,false,true,false];
  i int; k int;
BEGIN
  FOR i IN 1..array_length(ids,1) LOOP
    INSERT INTO editions VALUES (ids[i], circ[i]);
    INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version)
      VALUES (ids[i], c, fmv[i], conf[i], algo[i]);
    FOR k IN 1..nsales[i] LOOP
      -- SKEW editions get their last sale at $100 so p90 (64) separates from med (10).
      INSERT INTO sales VALUES (
        ids[i], c,
        CASE WHEN skewed[i] AND k = nsales[i] THEN 100 ELSE 10 END,
        now() - interval '10 days');
    END LOOP;
  END LOOP;
END $seed$;

-- ── dry-run: counts targets but mutates NOTHING ─────────────────────────────
SELECT _assert_eq((SELECT rows_clamped::text FROM fmv_clamp_disconnected_ask_topshot(true)),
  '4', 'dry-run counts the 4 disconnected targets');
SELECT _assert_eq((SELECT count(*)::text FROM pipeline_runs), '0', 'dry-run writes no pipeline_runs row');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e1111111-1111-1111-1111-111111111111'),
  '100', 'dry-run leaves FMV untouched');

-- ── real run: dollars removed = (100-15)+(100-15)+(200-96)+(50-15) ──────────
SELECT _assert_eq((SELECT dollars_removed::text FROM fmv_clamp_disconnected_ask_topshot(false)),
  '309.00', 'real run removes $309 across the 4 targets');

-- clamp floor = GREATEST(p90*1.5, med): 15.00 on FLAT, 96.00 on SKEW
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e1111111-1111-1111-1111-111111111111'),
  '15.00', 'FLAT target clamped to p90*1.5 = 15');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e7777777-7777-7777-7777-777777777777'),
  '96.00', 'SKEW target clamped to p90*1.5 = 96, not to the median');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e8888888-8888-8888-8888-888888888888'),
  '15.00', 'low-circulation ASK_ONLY row is clamped — the predicate ignores circulation');

-- algo_version tagging
SELECT _assert_eq((SELECT algo_version FROM fmv_snapshots WHERE edition_id = 'e1111111-1111-1111-1111-111111111111'),
  'v2_p90clamp', 'fresh snapshot gets _p90clamp appended');
SELECT _assert_eq((SELECT algo_version FROM fmv_snapshots WHERE edition_id = 'e6666666-6666-6666-6666-666666666666'),
  'v2_p90clamp', 'already-tagged snapshot is NOT double-appended');

-- non-targets untouched — each blocked by a DIFFERENT gate
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e2222222-2222-2222-2222-222222222222'),
  '20', 'above p90*1.5 but under med*3 is left alone (median gate binds)');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e3333333-3333-3333-3333-333333333333'),
  '50', 'above med*3 but under p90*1.5 is left alone (p90 gate binds)');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e4444444-4444-4444-4444-444444444444'),
  '100', 'HIGH-confidence FMV is never clamped');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e5555555-5555-5555-5555-555555555555'),
  '100', 'edition with < 5 real sales is left alone');

-- the real run logs exactly one pipeline_runs row
SELECT _assert_eq((SELECT count(*)::text FROM pipeline_runs WHERE pipeline = 'fmv-clamp-disconnected-ask'),
  '1', 'real run logs one pipeline_runs row');

-- ── idempotence + the no-op logging guard ───────────────────────────────────
-- Every clamped row now sits AT its floor, so a second pass finds nothing (the
-- predicate is strict `>`). The live function wraps its pipeline_runs INSERT in
-- `IF v_clamped > 0`, so a no-op run must stay silent rather than logging a
-- zero-row success — the superseded copy logged unconditionally.
SELECT _assert_eq((SELECT rows_clamped::text FROM fmv_clamp_disconnected_ask_topshot(false)),
  '0', 'second pass is a no-op — clamped rows sit at their floor');
SELECT _assert_eq((SELECT count(*)::text FROM pipeline_runs WHERE pipeline = 'fmv-clamp-disconnected-ask'),
  '1', 'a no-op run logs NO additional pipeline_runs row');

SELECT '✓ fmv_clamp_disconnected_ask_topshot invariants pass' AS result;
ROLLBACK;
