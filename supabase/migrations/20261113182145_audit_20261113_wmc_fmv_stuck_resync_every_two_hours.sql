-- audit_20261113_wmc_fmv_stuck_resync_every_two_hours
--
-- Claude Code cloud, 2026-11-13 ~10:20 AM PT. Schedule only: rpc-wmc-fmv-stuck-resync (job 617, cron_heavy)
-- '33 * * * *' -> '33 */2 * * *'. known-issues #248, lever (a) "or run it less often".
--
-- WHY: resync_stuck_wmc_fmv is one of the estate's largest disk readers. Last 24 h (11-12 10:33 AM -> 11-13
-- 9:33 AM PT): 85-305 s per run, ~170 s mean, every hour (~68 min of cron_heavy DB time a day). Its cost is the
-- holder visit, not the fixes: the eligible-edition probe is ~114k buffers / 6 s for Top Shot; the rest is an
-- index + heap fetch of every wallet row of every stable edition (~1.15M Top Shot + All Day rows per run).
--
-- MEASURED, and why the incremental variant (#248 lever (a) first half) was NOT built: restricting each run to
-- editions whose current FMV became stable in the last 3 h keeps 3,756 of 8,090 Top Shot editions but 756k of
-- 857k holder rows (88 %), and 1,302 / 3,545 All Day editions but 252k of 291k rows (87 %) — the most-held
-- editions are the ones the engine re-prices most often. A window cuts edition probes, not the cost.
-- Lever (b) (carry confidence in refresh_wmc_fmv_changed) would add only ~92 editions per 2 h to that lane
-- (same price, changed confidence, of 3,665 re-priced) but changes a pinned hot function with a pre-registered
-- revert bar — left for a session that can watch it 24 h.
--
-- COST OF THE CHANGE: drift the backstop catches lives up to ~2 h instead of ~1 h. Sampled 11-13 ~10:20 AM PT
-- (3 % tablesample, eligible Top Shot + All Day editions, ~45 min after a run): 10 price and 16 confidence-only
-- mismatches in 33,731 rows (0.08 %). Price drift on fresh writes is the 10-min refresh_wmc_fmv_changed lane's
-- job, not this one's; confidence is internal (CLAUDE.md concierge rule 3). Not 3 h: the watchlist allows
-- 183 min of silence and runs vary 85-305 s (the 11-10 Candy re-time made the same call).
-- Even hours at :33 share the minute only with mv-pack-ev-latest (3,33 hourly, as before) and the small daily
-- 10:33Z Pinnacle names selfheal; the Candy forced resync is at :18 on even hours.
--
-- HOW: the 20260919045716 recipe — as cron_heavy, cron.schedule(jobname, ...) upserts on (jobname, username),
-- keeping the same jobid. Asserted: same jobid, cron_heavy, active, new schedule.
--
-- EXIT (#248): pgss/pipeline_runs over the next 24 h — 12 runs instead of 24, per-run duration within its
-- 85-305 s band (a 2 h backlog must not double the per-run cost), and a re-sample of the mismatch rate.
--
-- REVERT: SET ROLE cron_heavy; SELECT cron.schedule('rpc-wmc-fmv-stuck-resync', '33 * * * *',
--         'SELECT public.resync_stuck_wmc_fmv();'); RESET ROLE;

DO $$
DECLARE v_n int; v_id bigint;
BEGIN
  SELECT count(*), max(jobid) INTO v_n, v_id FROM cron.job
   WHERE jobname = 'rpc-wmc-fmv-stuck-resync' AND username = 'cron_heavy' AND schedule = '33 * * * *'
     AND command = 'SELECT public.resync_stuck_wmc_fmv();';
  IF v_n <> 1 THEN RAISE EXCEPTION 'rpc-wmc-fmv-stuck-resync: expected the hourly :33 cron_heavy job, found % match(es)', v_n; END IF;
  SET LOCAL ROLE cron_heavy;
  PERFORM cron.schedule('rpc-wmc-fmv-stuck-resync', '33 */2 * * *', 'SELECT public.resync_stuck_wmc_fmv();');
  RESET ROLE;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync') <> 1
     OR (SELECT jobid FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync') <> v_id
     OR (SELECT schedule FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync' AND username = 'cron_heavy' AND active) <> '33 */2 * * *' THEN
    RAISE EXCEPTION 'rpc-wmc-fmv-stuck-resync: not re-timed in place (same jobid, cron_heavy, active)';
  END IF;
END $$;
