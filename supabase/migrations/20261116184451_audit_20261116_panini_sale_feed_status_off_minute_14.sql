-- audit_20261116_panini_sale_feed_status_off_minute_14
--
-- Claude Code cloud, 2026-11-16 ~10:45 AM PT. known-issues #253: rpc-panini-sale-feed-status-refresh
-- (job 714, postgres) '14 * * * *' -> '53 * * * *'. Same jobid (cron.schedule on the same jobname), same command.
--
-- WHY: 714's duration splits by hour parity. 7 d of cron.job_run_details (98 runs each side):
--   even UTC hours: median 50 s, mean-ok 55 s, 13 runs >= 90 s, 5 statement-timeout kills;
--   odd  UTC hours: median 27 s, mean-ok 30 s,  4 runs >= 90 s, 3 kills.
-- The even hours are exactly when job 850 rpc-pack-rip-backfill-eligible-refresh ('14 */2 * * *', first run
-- 11-09, 35-61 s per run) starts in the SAME minute: in the last 30 h it overlapped 15/15 even-hour 714 runs and
-- 0/15 odd ones. Every other overlapping job overlapped both parities.
-- Slot score (other-job seconds overlapping a 2-min window, 96 hours, every job but 714 and the
-- every-minute lanes, which are uniform across minutes):
--   :14  mean 124 s, p90 197, max 384, 48/96 hours >= 120 s;
--   :53  mean  32 s, p90  51, max 105,  0/96 hours >= 120 s  (best of the 60 minutes on a 48 h scan).
-- This does NOT remove the heap fetches #253 names; it removes the contention that doubles them. Kills on odd
-- hours (3 in 7 d) remain; #253's re-open trigger is unchanged.
--
-- Downstream: nothing pins the minute (repo grep 11-16); the view serves the snapshot for 2 h 15 m and the
-- alarm reads age (185/245 min), so a 21-minute phase shift reads as neither stale nor a gap.
--
-- REVERT: SELECT cron.schedule('rpc-panini-sale-feed-status-refresh', '14 * * * *',
--         'SELECT public.refresh_panini_sale_feed_status();');

DO $$
DECLARE v_n int; v_id bigint;
BEGIN
  SELECT count(*), max(jobid) INTO v_n, v_id FROM cron.job
   WHERE jobname = 'rpc-panini-sale-feed-status-refresh' AND username = 'postgres' AND schedule = '14 * * * *'
     AND command = 'SELECT public.refresh_panini_sale_feed_status();' AND active;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'rpc-panini-sale-feed-status-refresh: expected the active hourly :14 postgres job, found % match(es)', v_n;
  END IF;

  PERFORM cron.schedule('rpc-panini-sale-feed-status-refresh', '53 * * * *',
                        'SELECT public.refresh_panini_sale_feed_status();');

  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-panini-sale-feed-status-refresh') <> 1
     OR (SELECT jobid FROM cron.job WHERE jobname = 'rpc-panini-sale-feed-status-refresh') <> v_id
     OR (SELECT schedule FROM cron.job WHERE jobname = 'rpc-panini-sale-feed-status-refresh'
          AND username = 'postgres' AND active) <> '53 * * * *' THEN
    RAISE EXCEPTION 'rpc-panini-sale-feed-status-refresh: not re-timed in place (same jobid, postgres, active)';
  END IF;
END $$;
