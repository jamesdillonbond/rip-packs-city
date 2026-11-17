-- RECORD ONLY -- applied in prod via execute_sql, NOT apply_migration, so this
-- file is deliberately ABSENT from supabase_migrations.schema_migrations.
-- Its absence there is NOT evidence it was never applied (jobid 333 is live);
-- migration-parity.yml only reports the inverse direction (prod-applied with no
-- committed file) and is structurally silent on this one.
--
-- Schedules the daily buyback-analytics MV refresh. 08:51Z is chosen because:
--   * the institutional snapshot diff lands ~07:53Z, so an hour of margin;
--   * minute 51 collides with NO hourly job and no */2, */3, */4, */5, */10 or
--     */30 job on this instance (checked against cron.job before scheduling);
--   * hour 8 already carries daily jobs at :15, :30, :45 and :55, so :51 sits
--     between them.
-- Measured cost: 144 ms, 22 disk reads -- negligible against the 120s global
-- statement_timeout, so no cron_heavy ownership is needed.
--
-- Revert: SELECT cron.unschedule('rpc-refresh-topshot-buyback-daily');
SELECT cron.schedule(
  'rpc-refresh-topshot-buyback-daily',
  '51 8 * * *',
  $$select public.refresh_topshot_buyback_daily()$$
);
