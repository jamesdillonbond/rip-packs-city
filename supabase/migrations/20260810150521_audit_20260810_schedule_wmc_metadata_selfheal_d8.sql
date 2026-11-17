-- audit_20260810_schedule_wmc_metadata_selfheal_d8
--
-- Deep-audit register D8: schedule the observable wmc-metadata self-heal daily.
-- 47 10 * * * = 03:47 PT, a quiet UTC hour (only one Sunday-weekly job at :20).
--
-- In-command `SET statement_timeout='300s'; ` prefix: pg_cron runs as postgres
-- under the global 120s cap, and both the wrapper's (180s) and the inner
-- backfill's (120s) proconfig timeouts are INERT for the calling statement (the
-- timer is armed before the function's GUC nest level is entered — the documented
-- statement_timeout mechanism). So the prefix is the only lever that gives the
-- daily global heal the room it needs (AllDay/TS regenerated backlog can be a
-- multi-thousand-row write across wmc's 15 indexes). Quiet-window scheduling keeps
-- it clear of the disk-IO-budget saturation the platform is prone to.
--
-- Revert: SELECT cron.unschedule('rpc-wmc-metadata-selfheal');

SELECT cron.schedule(
  'rpc-wmc-metadata-selfheal',
  '47 10 * * *',
  $cron$SET statement_timeout='300s'; SELECT public.rpc_wmc_metadata_selfheal();$cron$
);
