-- audit_20261113_candy_alias_apply_hourly — 2026-11-13 ~6:15 PM PT (Claude Code cloud; the #247 follow-up check).
-- The alias move drained: candy-edition-key-alias-apply wmc_left 0 since the 6:00 PM PT tick (18 runs, 0 failed), and
-- the triggers rewrite every new alias write at the source. Job 877 stays as a backstop for rows a future refresh
-- aliases (the daily refresh can add aliases; their existing holdings then need one move), hourly instead of every
-- 5 minutes. Revert: SELECT cron.alter_job(877, schedule := '*/5 * * * *');
DO $guard$
BEGIN
  IF (SELECT schedule FROM cron.job WHERE jobid = 877 AND jobname = 'rpc-candy-edition-key-alias-apply') IS DISTINCT FROM '*/5 * * * *' THEN
    RAISE EXCEPTION 'job 877 is not the 5-minute candy alias apply job; re-read before altering';
  END IF;
END $guard$;
SELECT cron.alter_job(877, schedule := '12 * * * *');
