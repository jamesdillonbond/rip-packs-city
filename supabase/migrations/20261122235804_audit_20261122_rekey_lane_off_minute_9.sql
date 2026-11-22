-- audit_20261122_rekey_lane_off_minute_9 — 2026-11-22 ~4:10 PM PT (Claude Code cloud, autonomous pass).
--
-- WHY. fmv-recalc's historical fallback (fmv_recalc_historical_candidates, 60 s cap) times out on 16 of 77 runs
-- started at :08 (21 %), against 1 of 77 at :28 and 1 of 76 at :48 (72 h). The :08 runs average 75 s vs ~50 s.
-- Overlap base rate: rpc-pack-rips-chain-rekey (job 704, `9,39`) overlaps 82 % of :08 runs and 0 % of :28/:48.
-- Minute 9 is the heaviest pg_cron minute (153 s of job time per hour started; minute 3: 38 s). The rekey lane
-- ran ~0.1 s when it shipped (10-04); it now averages 31 s (max 58 s) on a 3x larger identity population.
--
-- WHAT. Job 704's :09 run moves to :03, so it ends (max 58 s) before the :08 fmv-recalc starts. Its :39 run stays
-- (no fmv-recalc then). Gaps 36 / 24 min, both inside the function's 1-hour lookback, so no identity is skipped.
-- Same job, same command, no new lane.
--
-- REVERT: SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-pack-rips-chain-rekey'), schedule => '9,39 * * * *');
-- WATCH: fmv-recalc extra.historical_fallback_error on :08 runs falls toward the :28/:48 rate (~1 %).

DO $guard$
BEGIN
  IF (SELECT schedule FROM cron.job WHERE jobname = 'rpc-pack-rips-chain-rekey') IS DISTINCT FROM '9,39 * * * *' THEN
    RAISE EXCEPTION 'rpc-pack-rips-chain-rekey schedule is not 9,39 * * * *; re-read before moving';
  END IF;
END
$guard$;

SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-pack-rips-chain-rekey'), schedule => '3,39 * * * *');
