-- audit_20260829_reown_sales_hot_partition_vacuum_to_cron_heavy_twice_daily
--
-- WHY: pg_cron jobid 380 `maint-vacuum-sales-hot-partition` (`20 10 * * *`, owner postgres) has NEVER completed:
-- its only run (2026-08-29 10:20:00Z) was cancelled at 120.08 s by the cluster statement_timeout that `postgres`
-- inherits (no rolconfig). `cron_heavy` carries statement_timeout=600s and, since 20260829170822, MAINTAIN on
-- public.sales_2026 -- so the re-own can no longer produce a job that skips the VACUUM and reports "succeeded".
-- The comment on sales_2026 (20260829171533) records the decay as DIURNAL (~4.5x faster in the PT afternoon than
-- overnight) and that a single 10:20Z slot "would land at the START of the slow overnight decay and leave the fast
-- afternoon decay uncovered". So: TWO slots, both in hours with ZERO pg_cron startup timeouts over the last 7 days
-- (08, 10, 11, 20, 23Z measured 2026-08-29 23:5xZ) and on a minute no other job uses (53).
-- Cost: ~42 s of IO per pass at the instance's 22 MB/s floor (per 20260829111140), twice a day.
-- This is IO hygiene on the hot partition, not the leaderboard fix -- that shipped as 20260829234203 and does not
-- depend on this job.
--
-- pg_cron keys jobs on (jobname, username), so the re-own is unschedule + schedule and the jobid changes.
--
-- REVERT (restores the original never-working job, owner postgres, `20 10 * * *`):
--   SELECT cron.unschedule('maint-vacuum-sales-hot-partition');  -- run as cron_heavy: SET LOCAL ROLE cron_heavy first
--   SELECT cron.schedule('maint-vacuum-sales-hot-partition', '20 10 * * *', 'VACUUM (ANALYZE) public.sales_2026');

DO $mig$
DECLARE v_old int; v_new int;
BEGIN
  SELECT jobid INTO v_old FROM cron.job WHERE jobname = 'maint-vacuum-sales-hot-partition' AND username = 'postgres';
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: no postgres-owned maint-vacuum-sales-hot-partition job (expected jobid 380)';
  END IF;
  IF NOT has_table_privilege('cron_heavy', 'public.sales_2026', 'MAINTAIN') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: cron_heavy lacks MAINTAIN on sales_2026 -- 20260829170822 not applied; a re-own now would SKIP the vacuum';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE username = 'cron_heavy' AND jobname = 'maint-vacuum-sales-hot-partition') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: a cron_heavy copy already exists';
  END IF;

  PERFORM cron.unschedule(v_old);

  SET LOCAL ROLE cron_heavy;
  v_new := cron.schedule('maint-vacuum-sales-hot-partition', '53 10,20 * * *', 'VACUUM (ANALYZE) public.sales_2026');
  RESET ROLE;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_new AND username = 'cron_heavy' AND schedule = '53 10,20 * * *' AND active) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: new job % not found as cron_heavy/active', v_new;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_old) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: old jobid % still present', v_old;
  END IF;
  RAISE NOTICE 'maint-vacuum-sales-hot-partition re-owned: jobid % (postgres) -> % (cron_heavy), 53 10,20 * * *', v_old, v_new;
END
$mig$;