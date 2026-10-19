-- #195 follow-up (2026-10-18, Cowork cloud) — the last fabricated zeros on the heartbeat MARKERS.
--
-- Cause: two pg_cron wrappers write a `<pipeline>-heartbeat` marker BEFORE the work through the
-- 11-arg log_pipeline_run, naming only p_extra. The 11-arg form defaults an OMITTED counter to 0,
-- so every marker logged rows_found / rows_written / rows_skipped = 0 — a measured-looking zero on
-- a row that measures nothing (CLAUDE.md: a heartbeat marker is written with rows_* NULL).
-- Evidence (read 2026-10-18 ~4:58 PM PT, 24 h): exactly 10 '-heartbeat' pipelines carried non-NULL
-- counts — refresh-pack-grail-metrics-mv-heartbeat (24 rows) and the nine thp-leg-*-heartbeat
-- markers (4 each) — against 51 marker pipelines already logging NULL. The two writers are
-- run_refresh_pack_grail_metrics_mv_job() and run_thp_leg_logged(regprocedure,text).
-- run_thp_leg_logged's FINAL row also passed an explicit 0, 0, 0: a trust-health leg run has no
-- row count either (it writes one history row per metric through its own body), so that becomes
-- NULL too — the same call 20261018222342 made for the grail MV refresh.
--
-- Readers checked before changing a count to NULL: check_zero_yield_lanes() keys on
-- found_baseline > 0 (a 0 and a NULL both stay outside it); check_pipelines_running_but_not_succeeding()
-- sums coalesce(rows_written, 0) (unchanged). Neither function is drift-pinned in __tests__.
--
-- Built from the LIVE prosrc (md5 guard below), one-token edits only.
-- anon-exec: unchanged (run_refresh_pack_grail_metrics_mv_job, run_thp_leg_logged) — CREATE OR REPLACE of existing fns, same signatures; ACLs restated below, anon/authenticated never granted.
--
-- Revert: re-apply the bodies from 20261018222342 (grail) and 20260830021550 (run_thp_leg_logged).
-- Falsifier: any row where pipeline LIKE '%-heartbeat' AND rows_written IS NOT NULL after this apply.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.run_refresh_pack_grail_metrics_mv_job()'::regprocedure) <> 'f01a94e5db1f9aae8a528ad6a8288cdb' THEN
    RAISE EXCEPTION 'run_refresh_pack_grail_metrics_mv_job live body is not the one this migration was built from';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.run_thp_leg_logged(regprocedure,text)'::regprocedure) <> '1139ca69c3817f440a6b9157a8e10db0' THEN
    RAISE EXCEPTION 'run_thp_leg_logged live body is not the one this migration was built from';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.run_refresh_pack_grail_metrics_mv_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ok boolean := true;
  v_err text := NULL;
BEGIN
  -- Heartbeat FIRST, same shape the route wrote (a marker under the real name would refresh last_run and silence the arm).
  -- A marker measures nothing: NULL counts, never the 11-arg form's omitted-counter 0 (#195 follow-up, 2026-10-18).
  PERFORM public.log_pipeline_run('refresh-pack-grail-metrics-mv-heartbeat', v_started, NULL::int, NULL::int, NULL::int,
                                  p_extra => jsonb_build_object('phase', 'started', 'via', 'pg_cron'));
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.pack_grail_metrics_mv;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- includes 57014 query_canceled from the role statement_timeout: the refresh rolls back, the row below still lands.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  -- An MV refresh has no row counts: NULL (unmeasured), never a written 0 (#195, 2026-10-18).
  PERFORM public.log_pipeline_run('refresh-pack-grail-metrics-mv', v_started, NULL::int, NULL::int, NULL::int, v_ok, v_err,
                                  p_extra => jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int, 'via', 'pg_cron'));
END
$fn$;

CREATE OR REPLACE FUNCTION public.run_thp_leg_logged(p_fn regprocedure, p_pipeline text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ok boolean := true;
  v_err text := NULL;
  v_name text;
BEGIN
  SELECT p.proname INTO v_name FROM pg_proc p WHERE p.oid = p_fn::oid;
  IF v_name IS NULL OR v_name NOT LIKE 'rpc\_thp\_leg\_%' THEN
    RAISE EXCEPTION 'run_thp_leg_logged refuses %: only rpc_thp_leg_* functions may be run through it', p_fn;
  END IF;
  IF p_pipeline IS NULL OR p_pipeline NOT LIKE 'thp-leg-%' THEN
    RAISE EXCEPTION 'run_thp_leg_logged: pipeline name must start with thp-leg- (got %)', p_pipeline;
  END IF;
  -- A marker measures nothing: NULL counts, never the 11-arg form's omitted-counter 0 (#195 follow-up, 2026-10-18).
  PERFORM public.log_pipeline_run(p_pipeline || '-heartbeat', v_started, NULL::int, NULL::int, NULL::int,
                                  p_extra => jsonb_build_object('phase', 'started', 'via', 'pg_cron', 'fn', v_name));
  BEGIN
    EXECUTE format('SELECT %s()', quote_ident(v_name));
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  -- A leg run has no row count of its own: NULL (unmeasured), never a written 0 (#195 follow-up, 2026-10-18).
  PERFORM public.log_pipeline_run(p_pipeline, v_started, NULL::int, NULL::int, NULL::int, v_ok, v_err,
                                  p_extra => jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int, 'via', 'pg_cron', 'fn', v_name));
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.run_refresh_pack_grail_metrics_mv_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_refresh_pack_grail_metrics_mv_job() TO cron_heavy, postgres, service_role;
REVOKE EXECUTE ON FUNCTION public.run_thp_leg_logged(regprocedure, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_thp_leg_logged(regprocedure, text) TO cron_heavy, postgres, service_role;
