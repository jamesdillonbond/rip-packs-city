-- The sentinel's `Pipeline Success Coverage` arm has read `daily-portfolio-snapshot 0/1 ok` for
-- days and the inbox filing 2026-09-19T1745Z concluded "two days of portfolio history are simply
-- missing … the gap is permanent". ⛔ RE-DERIVED 2026-09-19 6:45 PM PT AT THE OUTCOME TABLE, AND IT IS
-- NOT SO: `portfolio_snapshots` holds 27 rows for EACH of 09-16, 09-17, 09-18 and 09-19. They were
-- written by pg_cron jobid 490 `rpc-portfolio-snapshot-retry` (`17 11 * * *`, postgres), which
-- `succeeded` on all four days (12.3 / 45.2 / 23.6 / 30.0 s) while the 07:05Z cron-job.org route
-- run died at its 120 s ceiling on 09-18 and 09-19. Only 09-12 is genuinely missing.
--
-- So the arm was reporting a data gap that does not exist. The mechanism is the R110 class: the
-- retry's command was a bare `SELECT public.snapshot_all_user_portfolios();`, which writes NO
-- `pipeline_runs` row, so every sentinel arm was blind to the backstop BY CONSTRUCTION and read
-- the route's failure as the day's outcome. A filing that measured the self-report instead of the
-- outcome table inherited the same blindness ("measure the OUTCOME table, not the self-report").
--
-- This migration gives the retry the house wrapper shape (run_refresh_pack_grail_metrics_mv_job):
-- it calls the same function and writes a terminal `pipeline_runs` row under the SAME pipeline
-- name the route uses, with `via: pg_cron` in extra so the two callers stay distinguishable. The
-- arm then reads the day honestly (1 of 2 ok when the route dies and the retry lands). jobid 490
-- keeps its jobid, schedule and owner (same name + same owner ⇒ in-place update; asserted).
--
-- ⚠ Unchanged and still true: the ROUTE run at 07:05Z is R109's second victim and stays a clean
-- measurement of that; the function's proconfig statement_timeout=120s is inert here (pg_cron),
-- so the retry runs under postgres's 120 s cluster default as before.
--
-- Applied from Cowork cloud 2026-09-19 6:42 PM PT. ⚠ That session's push tooling is its own concern;
-- this file commits as usual.
--
-- EXIT: after the 4:17 AM PT tick, pipeline_runs holds a `daily-portfolio-snapshot` row with
-- extra.via = 'pg_cron' and ok = true, and the arm no longer lists the lane when the retry lands.
-- FALSIFIER: the tick succeeds in cron.job_run_details but no such row appears ⇒ the wrapper is
-- not what jobid 490 runs (re-read cron.job.command).
-- REVERT: SELECT cron.schedule('rpc-portfolio-snapshot-retry', '17 11 * * *',
--           'SELECT public.snapshot_all_user_portfolios();');
--         DROP FUNCTION public.run_portfolio_snapshot_retry_job();
--
-- anon-exec: intentional — REVOKEd from PUBLIC, anon, authenticated below; only pg_cron as
-- postgres calls it (run_portfolio_snapshot_retry_job)

CREATE OR REPLACE FUNCTION public.run_portfolio_snapshot_retry_job()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_res     jsonb;
  v_ok      boolean := true;
  v_err     text := NULL;
  v_rows    integer := NULL;
BEGIN
  BEGIN
    v_res := public.snapshot_all_user_portfolios();
    v_rows := (v_res->>'inserted')::integer;
  EXCEPTION WHEN OTHERS THEN
    -- includes 57014 query_canceled at the role/cluster statement_timeout: the insert rolls
    -- back, the row below still lands, and rows_written stays NULL (unmeasured, not zero).
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run(
    'daily-portfolio-snapshot', v_started, 0, v_rows, 0, v_ok, v_err,
    p_extra => jsonb_build_object(
      'via', 'pg_cron',
      'jobname', 'rpc-portfolio-snapshot-retry',
      'snapshot_date', v_res->>'snapshot_date',
      'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN coalesce(v_res, jsonb_build_object('ok', false, 'error', v_err));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.run_portfolio_snapshot_retry_job() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.run_portfolio_snapshot_retry_job() IS
  'pg_cron jobid 490 (rpc-portfolio-snapshot-retry, 17 11 UTC) wrapper: runs snapshot_all_user_portfolios() and writes a terminal pipeline_runs row under the route''s own name, daily-portfolio-snapshot, with extra.via = pg_cron. Added 2026-09-19 because the bare SELECT wrote no row and the sentinel read the 07:05Z route failure as the day''s outcome while this retry had written the day''s 27 rows.';

SELECT cron.schedule(
  'rpc-portfolio-snapshot-retry',
  '17 11 * * *',
  'SELECT public.run_portfolio_snapshot_retry_job();'
);

DO $$
DECLARE v_id int; v_cmd text; v_user text;
BEGIN
  SELECT jobid, command, username INTO v_id, v_cmd, v_user FROM cron.job WHERE jobname = 'rpc-portfolio-snapshot-retry';
  IF v_id IS DISTINCT FROM 490 THEN RAISE EXCEPTION 'jobid changed: %', v_id; END IF;
  IF v_user <> 'postgres' THEN RAISE EXCEPTION 'owner changed: %', v_user; END IF;
  IF strpos(v_cmd, 'run_portfolio_snapshot_retry_job') = 0 THEN RAISE EXCEPTION 'command not applied: %', v_cmd; END IF;
  IF has_function_privilege('anon', 'public.run_portfolio_snapshot_retry_job()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked'; END IF;
END $$;
