-- audit_20261125_panini_scarcer_for_less_off_minute_8
--
-- 2026-11-25 ~7:36 AM PT (Claude Code, attended; Trevor: "Keep digging and probing to try and figure it out").
-- WHY. fmv-recalc's :08 run (cron-job.org, same route as :28/:48) was the slow, erroring outlier. Split by UTC hour,
-- the :08 penalty is layered: odd hours ~74 s, even hours ~86 s, 0/6/12/18 ~102 s (vs ~53 s at :28/:48). The
-- even-hour layer is job 924 (panini-scarcer-for-less, '8 */2' — the SAME minute fmv-recalc starts), created
-- 2026-11-24 12:08 AM PT by 20261124064628. Before/after split on that change point, page runs only, 6-h hours
-- excluded (60 h of pipeline_runs):
--   :08 even   76 s -> 94 s   (n 7 / 9)    <- only this cell moved
--   :08 odd    76 s -> 72 s   (n 13 / 14)  control
--   :28/:48    57 s -> 51 s   (n 57 / 63)  control
-- WHAT. Move job 924 to minute 54 of even hours: the quietest pg_cron minute (24 s/h started, 60 h) and clear of all
-- three fmv-recalc windows (:08-:10, :28-:30, :48-:50). Cadence unchanged (every 2 h), so the watchlist bounds
-- (240 silent / 360 without success) still hold; only its notes text names the new slot.
-- NOT moved here: the 0/6/12/18 layer (jobs 330 rpc-thp-leg-panini '9 0,6,12,18' ~86 s and 208
-- rpc-refresh-topshot-pack-rip-values '5 */6' ~33 s). One change at a time so this one stays measurable.
-- VERIFY: even-hour :08 fmv-recalc page runs return to the odd-hour level (~72 s) over >= 10 runs.
-- REVERT:
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'panini-scarcer-for-less'), schedule := '8 */2 * * *');
--   UPDATE public.pipeline_cadence_watchlist SET notes = replace(notes, 'pg_cron 54 */2 * * *', 'pg_cron 8 */2 * * *')
--    WHERE pipeline = 'panini-scarcer-for-less';

SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'panini-scarcer-for-less'), schedule := '54 */2 * * *');

UPDATE public.pipeline_cadence_watchlist
   SET notes = replace(notes, 'pg_cron 8 */2 * * *', 'pg_cron 54 */2 * * *')
 WHERE pipeline = 'panini-scarcer-for-less';
