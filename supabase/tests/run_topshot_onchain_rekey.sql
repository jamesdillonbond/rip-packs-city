-- DB invariant: public.run_topshot_onchain_rekey — the pg_cron wrapper that runs the
-- Top Shot on-chain re-key where it has more than the ~120 s Supabase gateway cap, and
-- records the outcome in `pipeline_runs` so the re-key is observable at all.
--
-- WHY IT EXISTS. `remap_topshot_from_onchain_map()` was only ever reached through
-- /api/admin/drain-topshot-misattribution?rekey=1 — a Vercel cron, so PostgREST, so the
-- gateway's ~120 s ceiling regardless of the function's declared 300 s. On all five
-- `rekey: upstream request timeout` days between 08-23 and 08-28 the audit tables
-- gained ZERO rows: the gateway giving up ROLLS THE WORK BACK. It now runs as pg_cron
-- `rpc-topshot-onchain-rekey` under `cron_heavy` (role statement_timeout 600 s).
--
-- The behaviour that must hold:
--   (a) on SUCCESS a pipeline_runs row is written with ok = true, rows_written =
--       sales_rekeyed + moments_rekeyed, rows_skipped = moments_deferred_conflict.
--   (b) 🚨 on FAILURE a row is STILL written, with ok = false and the message in
--       `error` — the whole point of the wrapper. Silence is what pg_cron alone gives.
--   (c) ⛔ on failure the write counters are NULL, never 0. This repo's own rule:
--       `rows_written = 0` is a null instrument with three incompatible meanings, and a
--       measured zero on a run that measured nothing is a fabricated number.
--   (d) `rows_found` is ALWAYS NULL, success included — this function has no candidate
--       count of its own, and a 0 there would read as "nothing to do".
--   (e) a callee failure does NOT propagate. The caller is a cron tick; raising would
--       lose the pipeline_runs row this function exists to write.
--   (f) the returned jsonb carries `ok` on both paths, and the remap's own fields on
--       the success path.
--
-- ⚠ WHAT IS **NOT** COVERED HERE, stated so nobody reads this file as more than it is:
-- a `statement_timeout` KILL. It cannot be covered, and that is a property of
-- PostgreSQL rather than of this test — probed on the live database 2026-09-02, a
-- `SET LOCAL statement_timeout='300ms'` cancel propagated straight OUT of an
-- `EXCEPTION WHEN OTHERS` handler wrapping pg_sleep(2) (`57014`). So on a 600 s
-- overrun there is NO row here at all, and the only instrument is
-- `cron.job_run_details` (status='failed'). Do not "fix" (b) by asserting a timeout
-- row exists; it will not, and asserting something weaker that happens to pass is the
-- vacuous-test shape this repo keeps finding.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260902112507_audit_20260902_topshot_onchain_rekey_runs_where_it_has_more_than_120s.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs (
  id              bigserial PRIMARY KEY,
  pipeline        text,
  collection_slug text,
  started_at      timestamptz,
  finished_at     timestamptz,
  duration_ms     integer,
  rows_found      integer,
  rows_written    integer,
  rows_skipped    integer,
  cursor_before   text,
  cursor_after    text,
  ok              boolean,
  error           text,
  extra           jsonb
);

-- Stand-in for the real 11-arg log_pipeline_run. It is deliberately a DUMB INSERT:
-- the real one is pinned by supabase/tests/log_pipeline_run.sql, and duplicating its
-- logic here would make this file pass or fail for reasons that are not about the
-- wrapper. What matters is exactly what the wrapper HANDS it.
CREATE OR REPLACE FUNCTION public.log_pipeline_run(
  p_pipeline text, p_started_at timestamptz, p_rows_found integer,
  p_rows_written integer, p_rows_skipped integer, p_ok boolean, p_error text,
  p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb
) RETURNS bigint LANGUAGE plpgsql AS $stub$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.pipeline_runs
    (pipeline, collection_slug, started_at, finished_at, duration_ms,
     rows_found, rows_written, rows_skipped, cursor_before, cursor_after, ok, error, extra)
  VALUES
    (p_pipeline, p_collection_slug, p_started_at, clock_timestamp(),
     (EXTRACT(EPOCH FROM (clock_timestamp() - p_started_at)) * 1000)::int,
     p_rows_found, p_rows_written, p_rows_skipped, p_cursor_before, p_cursor_after,
     p_ok, p_error, p_extra)
  RETURNING id INTO v_id;
  RETURN v_id;
END $stub$;

-- Stand-in for the real remap. `zz.mode` switches it between the two paths so both
-- branches are driven by the SAME wrapper body, not by two different fixtures.
CREATE OR REPLACE FUNCTION public.remap_topshot_from_onchain_map()
RETURNS jsonb LANGUAGE plpgsql AS $stub$
BEGIN
  IF current_setting('zz.mode', true) = 'boom' THEN
    RAISE EXCEPTION 'remap exploded';
  END IF;
  RETURN jsonb_build_object(
    'sales_rekeyed', 12,
    'moments_rekeyed', 5,
    'moments_deferred_conflict', 3,
    'unresolved_targets', 7,
    'map_size', 49206);
END $stub$;

-- >>> BEGIN verbatim run_topshot_onchain_rekey (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.run_topshot_onchain_rekey()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_res     jsonb;
  v_err     text;
BEGIN
  BEGIN
    v_res := public.remap_topshot_from_onchain_map();
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    v_res := NULL;
  END;

  -- ⚠ rows_found stays NULL: this function has no candidate count of its own, and
  -- a 0 there would read as "nothing to do" rather than "not measured". Same rule
  -- for the write counters on the error path — NULL, never 0.
  PERFORM public.log_pipeline_run(
    'topshot-onchain-rekey',
    v_started,
    NULL,
    CASE WHEN v_err IS NULL
         THEN COALESCE((v_res->>'sales_rekeyed')::int, 0)
            + COALESCE((v_res->>'moments_rekeyed')::int, 0)
    END,
    CASE WHEN v_err IS NULL THEN (v_res->>'moments_deferred_conflict')::int END,
    v_err IS NULL,
    v_err,
    'nba_top_shot',
    NULL,
    NULL,
    jsonb_build_object('remap', v_res, 'rekey_error', v_err)
  );

  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_err);
  END IF;
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('ok', true);
END
$fn$;
-- <<< END verbatim run_topshot_onchain_rekey <<<

-- ── (1) the SUCCESS path ────────────────────────────────────────────────────────
SELECT set_config('zz.mode', 'ok', true);
SELECT _assert_eq((public.run_topshot_onchain_rekey()->>'ok'), 'true',
  'a successful remap returns ok:true');
SELECT _assert_eq((public.run_topshot_onchain_rekey()->>'map_size'), '49206',
  'the remap''s own fields survive the merge, so the cron log is not lossy');

SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs), '2',
  'every call writes exactly one pipeline_runs row');

SELECT _assert_eq(
  (SELECT ok::text FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), 'true',
  'the success row is ok=true');
SELECT _assert_eq(
  (SELECT pipeline FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), 'topshot-onchain-rekey',
  'it logs under its own pipeline name, not the drain''s');
SELECT _assert_eq(
  (SELECT collection_slug FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), 'nba_top_shot',
  'it logs the long-form Top Shot slug');
-- 12 sales + 5 moments. Summed rather than reported separately because rows_written is
-- one column; the split stays legible in extra->remap, asserted below.
SELECT _assert_eq(
  (SELECT rows_written::text FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), '17',
  'rows_written is sales_rekeyed + moments_rekeyed');
SELECT _assert_eq(
  (SELECT rows_skipped::text FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), '3',
  'rows_skipped is moments_deferred_conflict — the collisions the remap refuses to guess');
-- (d) — and this is the one an over-eager "fill in the counters" edit would break.
SELECT _assert_eq(
  (SELECT rows_found::text FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), NULL,
  'rows_found is NULL even on success: this function never measured a candidate count');
SELECT _assert_eq(
  (SELECT extra->'remap'->>'unresolved_targets' FROM public.pipeline_runs ORDER BY id DESC LIMIT 1),
  '7', 'the whole remap payload is kept in extra->remap');
SELECT _assert_eq(
  (SELECT extra->>'rekey_error' FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), NULL,
  'no rekey_error on a good run');

-- ── (2) the FAILURE path — the reason the wrapper exists ────────────────────────
SELECT set_config('zz.mode', 'boom', true);

-- (e) it must NOT raise. If this call throws, the test aborts here and that IS the
-- assertion: a cron tick that raises loses the row the wrapper is for.
SELECT _assert_eq((public.run_topshot_onchain_rekey()->>'ok'), 'false',
  'a failed remap returns ok:false rather than propagating');

SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs), '3',
  'the failure is RECORDED, not swallowed');
SELECT _assert_eq(
  (SELECT ok::text FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), 'false',
  'the failure row is ok=false');
SELECT _assert_eq(
  (SELECT error FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), 'remap exploded',
  'the callee''s message reaches `error`, so the failure is diagnosable from pipeline_runs alone');
SELECT _assert_eq(
  (SELECT extra->>'rekey_error' FROM public.pipeline_runs ORDER BY id DESC LIMIT 1),
  'remap exploded', 'and is mirrored in extra, where the fleet sweeps read');

-- (c) ⛔ THE LOAD-BEARING ABSENCES. A 0 in either column publishes a measured zero for
-- a run that measured nothing, and `rows_written = 0` already has three incompatible
-- meanings on this platform. NULL is the only honest value here.
SELECT _assert_eq(
  (SELECT rows_written::text FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), NULL,
  'rows_written is NULL on failure, NEVER 0');
SELECT _assert_eq(
  (SELECT rows_skipped::text FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), NULL,
  'rows_skipped is NULL on failure, NEVER 0');
SELECT _assert_eq(
  (SELECT rows_found::text FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), NULL,
  'rows_found is NULL on failure too');
SELECT _assert_eq(
  (SELECT extra->>'remap' FROM public.pipeline_runs ORDER BY id DESC LIMIT 1), NULL,
  'no remap payload is invented for a run that produced none');

ROLLBACK;
