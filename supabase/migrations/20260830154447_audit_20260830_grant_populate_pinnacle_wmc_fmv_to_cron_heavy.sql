-- audit_20260830: let cron_heavy run populate_pinnacle_wmc_fmv().
--
-- The hourly /api/cron/populate-pinnacle-wmc-fmv route caps the call at 125 s
-- (13 of 22 no-op runs and EVERY run since the 10:07Z catalog recompute died
-- there, so the Pinnacle wallet FMVs were 5.5 h stale at 15:40Z with the
-- statement running on server-side to its own 300 s). A catch-up job as
-- cron_heavy (600 s) failed with "permission denied for function" -- the
-- function was EXECUTE-able by service_role only.
--
-- anon-exec: populate_pinnacle_wmc_fmv -- GRANT EXECUTE TO cron_heavy only;
-- anon/authenticated/PUBLIC unchanged (none).

GRANT EXECUTE ON FUNCTION public.populate_pinnacle_wmc_fmv(integer) TO cron_heavy;
