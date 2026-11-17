-- One-off done: the cron_heavy run succeeded in 13 s. Remove it before it keeps
-- firing every minute.
-- ⚠ `cron.unschedule` must run AS THE OWNER — as postgres it errors
-- "could not find valid entry for job", which reads like the job does not exist
-- rather than like a permission problem.
SET LOCAL ROLE cron_heavy;
SELECT cron.unschedule('rpc-oneoff-edition-fmv-current-heavy');
RESET ROLE;