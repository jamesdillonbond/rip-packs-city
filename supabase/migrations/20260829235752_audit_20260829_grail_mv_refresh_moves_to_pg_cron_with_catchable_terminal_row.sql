-- audit_20260829_grail_mv_refresh_moves_to_pg_cron_with_catchable_terminal_row
--
-- WHY: `refresh-pack-grail-metrics-mv` ran as a Vercel route (app/api/cron/refresh-pack-grail-metrics-mv, maxDuration 60,
-- fired hourly at :23 by cron-job.org). Measured 2026-08-29: 24 heartbeats, 11 terminal rows -> 13 of 24 ticks (54%) were
-- killed at the 60 s lambda cap, while the DB-side REFRESH (function statement_timeout 300 s; completed durations p50 9.5 s,
-- max 55 s) committed anyway -- proven n=9 by audit_20260828_sample_grail_mv_commit_control. So the watchlist arm read
-- "silent 391m" on a ranking that had refreshed 40 min earlier: the outage was LOGGING ONLY, and the sentinel warned on it
-- every run. A lambda is the wrong owner for a statement that outlives it.
--
-- WHAT: the refresh becomes a cron_heavy pg_cron job (600 s role budget, no lambda to kill) through a wrapper that writes
-- the same heartbeat + terminal rows the route wrote, and -- unlike the route -- CATCHES a statement cancel (57014 is an
-- ordinary PL/pgSQL exception) so a timed-out refresh leaves an ok=false row with the error, never silence.
-- The cron-job.org entry "RPC Refresh Pack Grail Metrics MV" is DISABLED in the same pass (console, Common tab), so the
-- route stays deployed but unfired: re-enabling that entry is the cheapest revert.
--
-- REVERT: SELECT cron.unschedule('rpc-refresh-pack-grail-metrics-mv');  -- as cron_heavy (SET LOCAL ROLE cron_heavy)
--         DROP FUNCTION public.run_refresh_pack_grail_metrics_mv_job();
--         re-enable the cron-job.org entry.

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
  PERFORM public.log_pipeline_run('refresh-pack-grail-metrics-mv-heartbeat', v_started,
                                  p_extra => jsonb_build_object('phase', 'started', 'via', 'pg_cron'));
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.pack_grail_metrics_mv;
  EXCEPTION WHEN OTHERS THEN
    -- includes 57014 query_canceled from the role statement_timeout: the refresh rolls back, the row below still lands.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run('refresh-pack-grail-metrics-mv', v_started, 0, 0, 0, v_ok, v_err,
                                  p_extra => jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int, 'via', 'pg_cron'));
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.run_refresh_pack_grail_metrics_mv_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_refresh_pack_grail_metrics_mv_job() TO cron_heavy, postgres, service_role;

DO $mig$
DECLARE v_new int;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-refresh-pack-grail-metrics-mv') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: rpc-refresh-pack-grail-metrics-mv already scheduled';
  END IF;
  SET LOCAL ROLE cron_heavy;
  v_new := cron.schedule('rpc-refresh-pack-grail-metrics-mv', '23 * * * *', 'SELECT public.run_refresh_pack_grail_metrics_mv_job();');
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_new AND username = 'cron_heavy' AND active) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: job % not active as cron_heavy', v_new;
  END IF;
  RAISE NOTICE 'rpc-refresh-pack-grail-metrics-mv scheduled as jobid % (cron_heavy, 23 * * * *)', v_new;
END
$mig$;