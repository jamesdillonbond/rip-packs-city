-- audit_20260830_r25_thp_legs_get_pipeline_runs_rows_through_a_logged_wrapper
--
-- WHY (register R25, open since 2026-08-22): the eight `rpc_thp_leg_*` pg_cron jobs (trust-precompute legs, jobids
-- 324-331, cron_heavy) call `log_pipeline_run` NOWHERE, so their measured failure rates (14-25% per leg, run-4) exist only
-- in cron.job_run_details, which retains DISPATCH outcome and is invisible to detect_stalled_pipelines(), the sentinel's
-- Success Coverage arm and the watchlist. Their proconfig statement_timeouts are inert on pg_cron (R55); cron_heavy's 600 s
-- is the real budget.
--
-- WHAT: one generic SECURITY DEFINER wrapper, run_thp_leg_logged(regprocedure, text), in the shape proven tonight by
-- run_refresh_pack_grail_metrics_mv_job (20260829235752): heartbeat row first, the leg inside a BEGIN/EXCEPTION block so a
-- cancel (57014) or any error lands as an ok=false terminal row instead of silence, then the terminal row. The legs are
-- UNTOUCHED (no signature, body or ACL change). The wrapper refuses any function not named rpc_thp_leg_* so it cannot be
-- used as a generic executor, and anon/authenticated cannot execute it.
-- The eight jobs are re-pointed IN PLACE (cron.schedule on the same jobname+username keeps the jobid and schedule).
--
-- REVERT (restores the eight commands verbatim; the wrapper may then be dropped):
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.schedule('rpc-thp-leg-impossible-parallel','48 0,6,12,18 * * *','SELECT public.rpc_thp_leg_impossible_parallel();');
--   SELECT cron.schedule('rpc-thp-leg-fmv-coverage',       '48 1,7,13,19 * * *','SELECT public.rpc_thp_leg_fmv_coverage();');
--   SELECT cron.schedule('rpc-thp-leg-board-liveness',     '48 2,8,14,20 * * *','SELECT public.rpc_thp_leg_board_liveness();');
--   SELECT cron.schedule('rpc-thp-leg-serial-supply',      '48 3,9,15,21 * * *','SELECT public.rpc_thp_leg_serial_supply();');
--   SELECT cron.schedule('rpc-thp-leg-fmv-sanity',         '48 4,10,16,22 * * *','SELECT public.rpc_thp_leg_fmv_sanity();');
--   SELECT cron.schedule('rpc-thp-leg-pack-ev',            '48 5,11,17,23 * * *','SELECT public.rpc_thp_leg_pack_ev();');
--   SELECT cron.schedule('rpc-thp-leg-panini',             '9 0,6,12,18 * * *', 'SELECT public.rpc_thp_leg_panini();');
--   SELECT cron.schedule('rpc-thp-leg-pinnacle-fmv-share', '55 3,9,15,21 * * *','SELECT public.rpc_thp_leg_pinnacle_fmv_share();');
--   RESET ROLE;  DROP FUNCTION public.run_thp_leg_logged(regprocedure, text);

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
  PERFORM public.log_pipeline_run(p_pipeline || '-heartbeat', v_started,
                                  p_extra => jsonb_build_object('phase', 'started', 'via', 'pg_cron', 'fn', v_name));
  BEGIN
    EXECUTE format('SELECT %s()', quote_ident(v_name));
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run(p_pipeline, v_started, 0, 0, 0, v_ok, v_err,
                                  p_extra => jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int, 'via', 'pg_cron', 'fn', v_name));
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.run_thp_leg_logged(regprocedure, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_thp_leg_logged(regprocedure, text) TO cron_heavy, postgres, service_role;

DO $mig$
DECLARE r record; v int; n int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('rpc-thp-leg-impossible-parallel', 'rpc_thp_leg_impossible_parallel', 'thp-leg-impossible-parallel'),
      ('rpc-thp-leg-fmv-coverage',        'rpc_thp_leg_fmv_coverage',        'thp-leg-fmv-coverage'),
      ('rpc-thp-leg-board-liveness',      'rpc_thp_leg_board_liveness',      'thp-leg-board-liveness'),
      ('rpc-thp-leg-serial-supply',       'rpc_thp_leg_serial_supply',       'thp-leg-serial-supply'),
      ('rpc-thp-leg-fmv-sanity',          'rpc_thp_leg_fmv_sanity',          'thp-leg-fmv-sanity'),
      ('rpc-thp-leg-pack-ev',             'rpc_thp_leg_pack_ev',             'thp-leg-pack-ev'),
      ('rpc-thp-leg-panini',              'rpc_thp_leg_panini',              'thp-leg-panini'),
      ('rpc-thp-leg-pinnacle-fmv-share',  'rpc_thp_leg_pinnacle_fmv_share',  'thp-leg-pinnacle-fmv-share')
    ) AS t(jobname, fn, pipeline)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = r.jobname AND j.username = 'cron_heavy' AND j.command = format('SELECT public.%s();', r.fn)) THEN
      RAISE EXCEPTION 'PRE-STATE FAILED: % is not a cron_heavy job with command SELECT public.%();', r.jobname, r.fn;
    END IF;
  END LOOP;

  SET LOCAL ROLE cron_heavy;
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule, t.fn, t.pipeline
    FROM cron.job j
    JOIN (VALUES
      ('rpc-thp-leg-impossible-parallel', 'rpc_thp_leg_impossible_parallel', 'thp-leg-impossible-parallel'),
      ('rpc-thp-leg-fmv-coverage',        'rpc_thp_leg_fmv_coverage',        'thp-leg-fmv-coverage'),
      ('rpc-thp-leg-board-liveness',      'rpc_thp_leg_board_liveness',      'thp-leg-board-liveness'),
      ('rpc-thp-leg-serial-supply',       'rpc_thp_leg_serial_supply',       'thp-leg-serial-supply'),
      ('rpc-thp-leg-fmv-sanity',          'rpc_thp_leg_fmv_sanity',          'thp-leg-fmv-sanity'),
      ('rpc-thp-leg-pack-ev',             'rpc_thp_leg_pack_ev',             'thp-leg-pack-ev'),
      ('rpc-thp-leg-panini',              'rpc_thp_leg_panini',              'thp-leg-panini'),
      ('rpc-thp-leg-pinnacle-fmv-share',  'rpc_thp_leg_pinnacle_fmv_share',  'thp-leg-pinnacle-fmv-share')
    ) AS t(jobname, fn, pipeline) ON t.jobname = j.jobname
    WHERE j.username = 'cron_heavy'
  LOOP
    v := cron.schedule(r.jobname, r.schedule,
           format('SELECT public.run_thp_leg_logged(%L::regprocedure, %L);', 'public.' || r.fn || '()', r.pipeline));
    IF v <> r.jobid THEN
      RAISE EXCEPTION 'POST-STATE FAILED: % jobid changed % -> %', r.jobname, r.jobid, v;
    END IF;
    n := n + 1;
  END LOOP;
  RESET ROLE;
  IF n <> 8 THEN RAISE EXCEPTION 'POST-STATE FAILED: expected 8 jobs re-pointed, got %', n; END IF;
  RAISE NOTICE '8 thp legs now run through run_thp_leg_logged';
END
$mig$;