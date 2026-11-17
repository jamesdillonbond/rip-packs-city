-- audit_20260830_log_purges_off_the_09z_storm_band_and_grail_watchlist_note
--
-- (1) pg_cron jobid 198 `rpc-weekly-log-purges` ran at `54 9 * * *` (postgres, ~0.2 s). Hour 09Z carries 191 `job startup
--     timeout` failures over the last 7 days -- the worst hour on the instance (13Z: 226 is the only peer; 08/10/11/20/23Z
--     read ZERO, measured 2026-08-29 23:5xZ from cron.job_run_details). The 08-29 09:54Z tick never started, so the pipeline
--     `weekly-db-maintenance` read "silent 2160m (>1800m)" on the sentinel for a full day over a job that did nothing wrong.
--     Moved to `46 11 * * *` (04:46 PT): a zero-storm hour, minute 46 unused by any other job. Same role, same command.
--     REVERT: SELECT cron.schedule('rpc-weekly-log-purges', '54 9 * * *', 'SELECT public.run_weekly_log_purges()');
--             (cron.schedule on an existing (jobname, username) updates in place and keeps jobid 198.)
-- (2) Appends a dated line to pipeline_cadence_watchlist.notes for `refresh-pack-grail-metrics-mv` recording that the refresh
--     now runs as pg_cron jobid 384 (migration 20260829235752) and the cron-job.org entry is Inactive, so the next pass does
--     not re-derive the kill class. Data only.
--     REVERT: UPDATE public.pipeline_cadence_watchlist SET notes = split_part(notes, E'\n\n=== 2026-08-30 00:0xZ', 1)
--             WHERE pipeline = 'refresh-pack-grail-metrics-mv';

DO $mig$
DECLARE v_id int; v_n int;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'rpc-weekly-log-purges' AND username = 'postgres' AND schedule = '54 9 * * *';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: rpc-weekly-log-purges is not at 54 9 * * * as postgres';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE active AND split_part(schedule, ' ', 1) = '46' AND split_part(schedule, ' ', 2) IN ('11', '*')) THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: minute 46 at hour 11 is no longer free';
  END IF;
  v_n := cron.schedule('rpc-weekly-log-purges', '46 11 * * *', 'SELECT public.run_weekly_log_purges()');
  IF v_n <> v_id THEN
    RAISE EXCEPTION 'POST-STATE FAILED: jobid changed % -> % (expected in-place update)', v_id, v_n;
  END IF;

  UPDATE public.pipeline_cadence_watchlist
     SET notes = notes || E'\n\n=== 2026-08-30 00:0xZ (08-29 17:0x PT) -- REFRESH MOVED TO pg_cron. '
       || 'The route (maxDuration 60) was killed on 13 of 24 ticks on 08-29 while the DB refresh committed (n=9 commit control), so the arm read silence over a fresh ranking. '
       || 'Now: pg_cron jobid 384 rpc-refresh-pack-grail-metrics-mv, cron_heavy (600 s), 23 * * * *, via public.run_refresh_pack_grail_metrics_mv_job() which writes the same heartbeat + terminal rows and CATCHES a cancel into an ok=false row (migration 20260829235752). '
       || 'cron-job.org entry 7619844 "RPC Refresh Pack Grail Metrics MV" is Inactive (server-confirmed). Expect terminal rows every tick now; a heartbeat with no terminal row after this date means a job startup timeout, not a kill.'
   WHERE pipeline = 'refresh-pack-grail-metrics-mv';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POST-STATE FAILED: watchlist row for refresh-pack-grail-metrics-mv not found';
  END IF;
END
$mig$;