-- audit_20261115_wmc_fmv_stuck_resync_daily
--
-- Claude Code cloud, 2026-11-15 ~9:55 AM PT. known-issues #248 exit: rpc-wmc-fmv-stuck-resync (job 617,
-- cron_heavy) '33 */2 * * *' -> '33 12 * * *' (4:33 AM PT daily), and its pipeline_cadence_watchlist row
-- widened to match (183/366 min -> 1560/3000, the daily-lane convention), or the daily cadence pages as a stall.
--
-- WHY: #248's fast-lane fix (20261114171317) was to make this backstop rarely needed. Both exit checks passed:
--   * effect: fast-lane miss 0.11 % of wallet rows (8:45 AM PT re-sample; was 0.8 %, bar <= 0.2 %);
--   * cost, QUIET window 8:49:02 -> 9:50:06 AM PT (pgss diff on the two pinned queryids): service_role
--     12 calls, 5,907 disk reads/call (bar 7,195); cron_heavy 6 calls, 53 reads/call (bar 74,159).
-- The backstop's per-run cost is the holder visit (~395k reads on 11-14), not the backlog, so a daily run
-- costs about what a 2-hourly one did, ~12x fewer times.
-- Slot: :33 at 12 UTC is free (10/11/13 UTC already carry :33 jobs).
--
-- REVERT: SET ROLE cron_heavy; SELECT cron.schedule('rpc-wmc-fmv-stuck-resync', '33 */2 * * *',
--         'SELECT public.resync_stuck_wmc_fmv();'); RESET ROLE;
--         UPDATE public.pipeline_cadence_watchlist SET max_silent_minutes = 183, max_minutes_without_success = 366
--          WHERE pipeline = 'wmc-fmv-stuck-resync';

DO $$
DECLARE v_n int; v_id bigint;
BEGIN
  SELECT count(*), max(jobid) INTO v_n, v_id FROM cron.job
   WHERE jobname = 'rpc-wmc-fmv-stuck-resync' AND username = 'cron_heavy' AND schedule = '33 */2 * * *'
     AND command = 'SELECT public.resync_stuck_wmc_fmv();';
  IF v_n <> 1 THEN RAISE EXCEPTION 'rpc-wmc-fmv-stuck-resync: expected the 2-hourly :33 cron_heavy job, found % match(es)', v_n; END IF;
  SET LOCAL ROLE cron_heavy;
  PERFORM cron.schedule('rpc-wmc-fmv-stuck-resync', '33 12 * * *', 'SELECT public.resync_stuck_wmc_fmv();');
  RESET ROLE;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync') <> 1
     OR (SELECT jobid FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync') <> v_id
     OR (SELECT schedule FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync' AND username = 'cron_heavy' AND active) <> '33 12 * * *' THEN
    RAISE EXCEPTION 'rpc-wmc-fmv-stuck-resync: not re-timed in place (same jobid, cron_heavy, active)';
  END IF;

  UPDATE public.pipeline_cadence_watchlist
     SET max_silent_minutes = 1560, max_minutes_without_success = 3000,
         notes = notes || ' | 2026-11-15: job 617 moved to daily (#248 exit) -> 1560/3000.'
   WHERE pipeline = 'wmc-fmv-stuck-resync' AND max_silent_minutes = 183;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'wmc-fmv-stuck-resync watchlist: expected 1 row at 183 min, updated %', v_n; END IF;
END $$;
