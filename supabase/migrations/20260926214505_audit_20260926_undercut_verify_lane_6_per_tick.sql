-- rpc-ts-edition-verify-undercut: 3 -> 6 probes per tick (2026-09-26, #149).
-- Measured 1:04 -> 2:44 PM PT: the pool held flat (1,220 -> 1,208) while 105 editions were
-- re-priced by verification — new undercut NULLs arrive about as fast as 3 probes/tick clear them,
-- because a verified cheap listing ages out of the 24 h window again a day later. 6/tick
-- (1,728/day) out-runs the inflow. Atlas 403 rate on edition probes since the lane started:
-- 6 of 143 (~4 %), at baseline; the tick's own 4 probes run 3 minutes apart from these.
-- REVERT: SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-ts-edition-verify-undercut'),
--           command := 'SELECT public.atlas_edition_verify_dispatch_undercut(3);');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-ts-edition-verify-undercut'),
                      command := 'SELECT public.atlas_edition_verify_dispatch_undercut(6);');
