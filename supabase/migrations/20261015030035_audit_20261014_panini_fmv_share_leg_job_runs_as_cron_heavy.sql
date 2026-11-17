-- audit_20261014_panini_fmv_share_leg_job_runs_as_cron_heavy
--
-- 2026-10-14 ~8:00 PM PT. 20261015025957 scheduled rpc-thp-leg-panini-fmv-share from apply_migration,
-- which registered it as `postgres`. Every other rpc-thp-leg-* job is owned by cron_heavy (its own
-- 600 s budget; see 20260816150800 MECHANISM NOTE: postgres is a member of cron_heavy and cron_heavy
-- can execute cron.schedule, so SET LOCAL ROLE is the working path). Verified after apply:
-- cron.job username = cron_heavy, jobid 729.
--
-- REVERT: SELECT cron.unschedule('rpc-thp-leg-panini-fmv-share');  (then see 20261015025957's REVERT)

SELECT cron.unschedule('rpc-thp-leg-panini-fmv-share');
SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('rpc-thp-leg-panini-fmv-share', '57 3,9,15,21 * * *',
  $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_panini_fmv_share()'::regprocedure, 'thp-leg-panini-fmv-share');$$);
RESET ROLE;
