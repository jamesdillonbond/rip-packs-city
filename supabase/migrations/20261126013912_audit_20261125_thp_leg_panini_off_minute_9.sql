-- 2026-11-25 ~6:00 PM PT (Claude Code, attended) — move pg_cron job 330 `rpc-thp-leg-panini`
-- off minute 9 (`9 0,6,12,18`) to minute 58 (`58 0,6,12,18`).
--
-- Why: fmv-recalc's `:08` runs carry a penalty LAYERED by UTC hour (focus.md, 11-25): odd ~74 s,
-- even ~86 s, 0/6/12/18 ~102 s vs ~53 s at :28/:48. The even-hour layer was job 924 (moved
-- `20261125153639`). The 6-hour layer is this job (~85–140 s, starting 1 min after fmv-recalc's
-- :08 cron-job.org hit) plus job 208 (`5 */6`, ~33 s, not moved). Minute 58 is the quietest pg_cron
-- start minute measured (29 s/h over 24 h; minute 9's neighbours are 150+ s/h). Each thp leg is
-- independent (its own pipeline_runs name), so the offset from the other legs does not matter.
-- Separable from the job-924 read: this only touches the 0/6/12/18 UTC hours, which that read
-- excludes (it judges the even-NON-6h layer).
--
-- The job is owned by `cron_heavy`; postgres cannot `alter_job` it and cron_heavy has no EXECUTE on
-- alter_job, so it is re-`schedule`d under the same name as cron_heavy (pg_cron upserts by
-- jobname + username; jobid 330 kept, command verified identical before the change).
--
-- Revert:
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.schedule('rpc-thp-leg-panini', '9 0,6,12,18 * * *',
--     $c$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_panini()'::regprocedure, 'thp-leg-panini');$c$);
--   RESET ROLE;

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('rpc-thp-leg-panini', '58 0,6,12,18 * * *',
  $c$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_panini()'::regprocedure, 'thp-leg-panini');$c$);
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-thp-leg-panini') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one rpc-thp-leg-panini job';
  END IF;
  IF (SELECT schedule FROM cron.job WHERE jobname = 'rpc-thp-leg-panini') <> '58 0,6,12,18 * * *' THEN
    RAISE EXCEPTION 'rpc-thp-leg-panini schedule did not change';
  END IF;
  IF (SELECT username FROM cron.job WHERE jobname = 'rpc-thp-leg-panini') <> 'cron_heavy' THEN
    RAISE EXCEPTION 'rpc-thp-leg-panini no longer runs as cron_heavy';
  END IF;
END $$;
