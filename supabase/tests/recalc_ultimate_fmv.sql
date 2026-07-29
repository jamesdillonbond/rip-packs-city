-- DB invariant: public.recalc_ultimate_fmv — the ULTIMATE-tier FMV WRITER. It
-- reprices every ULTIMATE edition daily and writes fmv_snapshots. Because these
-- are the most valuable moments on the platform, the write-honesty rules here are
-- load-bearing: it must reprice ONLY ULTIMATE editions, must NOT insert a row when
-- the model produced no value, and must DELETE ONLY TODAY's own algo rows before
-- re-inserting (so historical snapshots and other pipelines' rows are never
-- clobbered — the same delete-only-today discipline the whole FMV layer relies on).
--
-- Pins:
--   * only tier='ULTIMATE' editions enter the source set (total_editions counts them);
--   * a row is inserted ONLY when the model fmv IS NOT NULL (no_data editions are
--     tallied but never written — no phantom $ on a grail);
--   * the pre-insert DELETE is scoped to (algo_version='ultimate-v1' AND today AND
--     an ULTIMATE edition): a prior-DAY ultimate-v1 row survives (history kept), a
--     TODAY row from a DIFFERENT algo survives, and a TODAY ultimate-v1 row on a
--     NON-ultimate edition survives (never touched);
--   * source-kind tallies (no_data / ask_only / sales_only / min_sale_ask) map from
--     the model's source label;
--   * a pipeline_runs audit row is written with the counts.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- fmv_confidence enum (the function casts the model's text confidence to it).
CREATE TYPE public.fmv_confidence AS ENUM
  ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.editions (id uuid PRIMARY KEY, tier text);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, collection_id uuid, collection text,
  fmv_usd numeric, floor_price_usd numeric, ask_proxy_fmv numeric,
  confidence public.fmv_confidence, days_since_sale integer,
  algo_version text, computed_at timestamptz);
CREATE TABLE public.pipeline_runs (
  pipeline text, started_at timestamptz, finished_at timestamptz,
  rows_found integer, rows_written integer, rows_skipped integer,
  ok boolean, extra jsonb);

-- Stub the per-edition model. Real one weighs sales/asks; here a fixture table
-- drives it so we can assert the writer's honesty gates deterministically.
CREATE TABLE public._ult_model (
  ed_id uuid, collection_id uuid, collection_slug text, fmv_usd numeric,
  lowest_non_special_ask numeric, confidence text, days_since_sale integer, source text);
CREATE FUNCTION public.compute_ultimate_non_special_fmv(p_edition_id uuid)
 RETURNS TABLE(collection_id uuid, collection_slug text, fmv_usd numeric,
   lowest_non_special_ask numeric, confidence text, days_since_sale integer, source text)
 LANGUAGE sql STABLE AS $$
  SELECT collection_id, collection_slug, fmv_usd, lowest_non_special_ask,
         confidence, days_since_sale, source
  FROM public._ult_model WHERE ed_id = p_edition_id
$$;

-- >>> BEGIN verbatim recalc_ultimate_fmv (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.recalc_ultimate_fmv()
 RETURNS TABLE(total_editions integer, inserted integer, no_data integer, ask_only integer, sales_only integer, min_sale_ask integer, ran_at timestamp with time zone, duration_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total int := 0;
  v_inserted int := 0;
  v_no_data int := 0;
  v_ask_only int := 0;
  v_sales_only int := 0;
  v_min int := 0;
  v_start timestamptz := clock_timestamp();
  v_ran timestamptz := now();
  v_finish timestamptz;
  v_dur int;
BEGIN
  DELETE FROM fmv_snapshots
  WHERE algo_version = 'ultimate-v1'
    AND computed_at >= date_trunc('day', v_ran)
    AND edition_id IN (SELECT id FROM editions WHERE tier = 'ULTIMATE');

  WITH src AS (
    SELECT
      e.id                          AS ed_id,
      r.collection_id               AS coll_id,
      r.collection_slug             AS coll_slug,
      r.fmv_usd                     AS fmv,
      r.lowest_non_special_ask      AS low_ask,
      r.confidence                  AS conf,
      r.days_since_sale             AS days,
      r.source                      AS src_kind
    FROM editions e
    LEFT JOIN LATERAL compute_ultimate_non_special_fmv(e.id) r ON true
    WHERE e.tier = 'ULTIMATE'
  ),
  ins AS (
    INSERT INTO fmv_snapshots (
      edition_id, collection_id, collection,
      fmv_usd, floor_price_usd, ask_proxy_fmv,
      confidence, days_since_sale,
      algo_version, computed_at
    )
    SELECT
      s.ed_id, s.coll_id, s.coll_slug,
      s.fmv, s.low_ask, s.low_ask,
      s.conf::fmv_confidence, s.days,
      'ultimate-v1', v_ran
    FROM src s
    WHERE s.fmv IS NOT NULL
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::int FROM src),
    (SELECT COUNT(*)::int FROM ins),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'no_data'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'ask_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'sale_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'min_sale_ask')
  INTO v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min;

  v_finish := clock_timestamp();
  v_dur := EXTRACT(MILLISECONDS FROM (v_finish - v_start))::int;

  INSERT INTO pipeline_runs (
    pipeline, started_at, finished_at,
    rows_found, rows_written, rows_skipped, ok, extra
  )
  VALUES (
    'ultimate-fmv-recalc-v1', v_start, v_finish,
    v_total, v_inserted, v_no_data, true,
    jsonb_build_object(
      'algo_version', 'ultimate-v1',
      'no_data', v_no_data,
      'ask_only', v_ask_only,
      'sales_only', v_sales_only,
      'min_sale_ask', v_min,
      'duration_ms', v_dur
    )
  );

  RETURN QUERY SELECT v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min, v_ran, v_dur;
END;
$function$;
-- <<< END verbatim recalc_ultimate_fmv <<<

\set edU1 '''11111111-1111-1111-1111-111111111111'''
\set edU2 '''22222222-2222-2222-2222-222222222222'''
\set edU3 '''33333333-3333-3333-3333-333333333333'''
\set edR1 '''44444444-4444-4444-4444-444444444444'''
\set coll '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.editions (id, tier) VALUES
  (:edU1::uuid, 'ULTIMATE'), (:edU2::uuid, 'ULTIMATE'),
  (:edU3::uuid, 'ULTIMATE'), (:edR1::uuid, 'RARE');

INSERT INTO public._ult_model (ed_id, collection_id, collection_slug, fmv_usd, lowest_non_special_ask, confidence, days_since_sale, source) VALUES
  (:edU1::uuid, :coll::uuid, 'nba_top_shot', 1000, 900, 'HIGH',     2, 'sale_only'),  -- inserts
  (:edU2::uuid, :coll::uuid, 'nba_top_shot', NULL, NULL, 'NO_DATA',  NULL, 'no_data'), -- NO insert
  (:edU3::uuid, :coll::uuid, 'nba_top_shot',  500, 500, 'ASK_ONLY',  9, 'ask_only');   -- inserts

-- Pre-existing snapshots that the DELETE must NOT touch (except edU1 today/ultimate-v1).
INSERT INTO public.fmv_snapshots (edition_id, collection_id, collection, fmv_usd, floor_price_usd, ask_proxy_fmv, confidence, days_since_sale, algo_version, computed_at) VALUES
  (:edU1::uuid, :coll::uuid, 'nba_top_shot', 111, 111, 111, 'HIGH', 1, 'ultimate-v1', now() - interval '1 day'),        -- YESTERDAY ultimate-v1 -> survives
  (:edU1::uuid, :coll::uuid, 'nba_top_shot', 222, 222, 222, 'HIGH', 1, 'ultimate-v1', date_trunc('day', now())),        -- TODAY ultimate-v1 -> DELETED + replaced
  (:edU1::uuid, :coll::uuid, 'nba_top_shot', 333, 333, 333, 'HIGH', 1, 'v1.7.0',      date_trunc('day', now())),        -- TODAY other algo -> survives
  (:edR1::uuid, :coll::uuid, 'nba_top_shot', 444, 444, 444, 'HIGH', 1, 'ultimate-v1', date_trunc('day', now()));        -- TODAY ultimate-v1 on NON-ultimate -> survives

SELECT * FROM public.recalc_ultimate_fmv() \gset run_

-- ── 1. return tuple: 3 ULTIMATE editions, 2 inserted, 1 no_data, 1 ask_only, 1 sales_only ──
SELECT _assert_eq(:'run_total_editions', '3', 'total_editions = 3 ULTIMATE editions (RARE excluded)');
SELECT _assert_eq(:'run_inserted', '2', 'inserted = 2 (edU1 + edU3; edU2 has NULL fmv)');
SELECT _assert_eq(:'run_no_data', '1', 'no_data = 1 (edU2)');
SELECT _assert_eq(:'run_ask_only', '1', 'ask_only = 1 (edU3)');
SELECT _assert_eq(:'run_sales_only', '1', 'sales_only = 1 (edU1, source=sale_only)');
SELECT _assert_eq(:'run_min_sale_ask', '0', 'min_sale_ask = 0');

-- ── 2. edU1 today/ultimate-v1: old (222) deleted, new (1000) inserted -> exactly one, = 1000 ──
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id = :edU1::uuid AND algo_version='ultimate-v1' AND computed_at >= date_trunc('day', now())),
  '1', 'edU1 has exactly one TODAY ultimate-v1 row after recalc');
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.fmv_snapshots WHERE edition_id = :edU1::uuid AND algo_version='ultimate-v1' AND computed_at >= date_trunc('day', now())),
  '1000', 'edU1 today row is the freshly-written 1000 (222 was deleted)');

-- ── 3. delete-only-today: the YESTERDAY ultimate-v1 row (111) survives ────────
SELECT _assert(EXISTS(SELECT 1 FROM public.fmv_snapshots WHERE edition_id=:edU1::uuid AND fmv_usd=111), 'yesterday ultimate-v1 snapshot preserved (history not clobbered)');

-- ── 4. delete-only-own-algo: today v1.7.0 row (333) survives ──────────────────
SELECT _assert(EXISTS(SELECT 1 FROM public.fmv_snapshots WHERE edition_id=:edU1::uuid AND fmv_usd=333), 'today non-ultimate-v1 snapshot preserved (other pipeline not clobbered)');

-- ── 5. delete scoped to ULTIMATE editions: edR1 today ultimate-v1 (444) survives ──
SELECT _assert(EXISTS(SELECT 1 FROM public.fmv_snapshots WHERE edition_id=:edR1::uuid AND fmv_usd=444), 'non-ULTIMATE edition today ultimate-v1 row untouched');

-- ── 6. no phantom on the no_data grail: edU2 got no snapshot ─────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id = :edU2::uuid),
  '0', 'edU2 (NULL model fmv) is never written — no phantom $ on a grail');

-- ── 7. audit trail: a pipeline_runs row with rows_written = inserted ──────────
SELECT _assert_eq(
  (SELECT rows_written::text FROM public.pipeline_runs WHERE pipeline='ultimate-fmv-recalc-v1'),
  '2', 'pipeline_runs audit row logs rows_written = 2');

SELECT '✓ recalc_ultimate_fmv: all assertions passed' AS result;

ROLLBACK;
