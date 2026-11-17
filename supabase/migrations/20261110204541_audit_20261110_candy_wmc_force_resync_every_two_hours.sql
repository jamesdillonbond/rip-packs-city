-- audit_20261110_candy_wmc_force_resync_every_two_hours
--
-- Claude Code cloud, 2026-11-10 ~12:45 PM PT. Schedule only: rpc-candy-wmc-fmv-resync (job 616, cron_heavy)
-- '18 * * * *' -> '18 */2 * * *'.
--
-- WHY: this Candy-only forced resync (#141, 09-25) was the stopgap the next day's estate-wide
-- resync_stuck_wmc_fmv (hourly :33, every collection INCLUDING Candy) generalised. Since the 11-08 census added
-- ~1.4M Candy wallet rows, each forced pass rebuilds the latest price of every Candy edition (only 191 of ~21.5k
-- carry one; ~15 s cold, 99k buffers) and compares it with every Candy wallet row: 12 s/run on 11-07 -> 186 s on
-- 11-09, ~170 s today. Yield: 11,535 rows on 11-08 and 16,700 on 11-09 (census churn), 15 rows across 13 runs on
-- 11-10. Every 2 h halves the cost (~2,000 s/day of cron_heavy). Not 3 h: the watchlist allows 183 min of silence
-- and run lengths vary 80-210 s, so a 180-min period would trip it.
--
-- HOW: pg_cron refuses alter_job here both ways (as postgres: "does not exist or you don't own it"; as cron_heavy:
-- no EXECUTE) — the 20260919045716 recipe: as cron_heavy, cron.schedule(jobname, ...) upserts on
-- (jobname, username), keeping the same jobid. Asserted: same jobid, cron_heavy, active, new schedule.
--
-- REVERT: SET ROLE cron_heavy; SELECT cron.schedule('rpc-candy-wmc-fmv-resync', '18 * * * *',
--         'SELECT public.run_candy_wmc_fmv_resync_job();'); RESET ROLE;

DO $$
DECLARE v_n int; v_id bigint;
BEGIN
  SELECT count(*), max(jobid) INTO v_n, v_id FROM cron.job
   WHERE jobname = 'rpc-candy-wmc-fmv-resync' AND username = 'cron_heavy' AND schedule = '18 * * * *'
     AND command = 'SELECT public.run_candy_wmc_fmv_resync_job();';
  IF v_n <> 1 THEN RAISE EXCEPTION 'rpc-candy-wmc-fmv-resync: expected the hourly :18 cron_heavy job, found % match(es)', v_n; END IF;
  SET LOCAL ROLE cron_heavy;
  PERFORM cron.schedule('rpc-candy-wmc-fmv-resync', '18 */2 * * *', 'SELECT public.run_candy_wmc_fmv_resync_job();');
  RESET ROLE;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-candy-wmc-fmv-resync') <> 1
     OR (SELECT jobid FROM cron.job WHERE jobname = 'rpc-candy-wmc-fmv-resync') <> v_id
     OR (SELECT schedule FROM cron.job WHERE jobname = 'rpc-candy-wmc-fmv-resync' AND username = 'cron_heavy' AND active) <> '18 */2 * * *' THEN
    RAISE EXCEPTION 'rpc-candy-wmc-fmv-resync: not re-timed in place (same jobid, cron_heavy, active)';
  END IF;
END $$;
