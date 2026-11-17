-- jobid 324 `rpc-thp-leg-impossible-parallel` (cron_heavy, `48 0,6,12,18`) ran ONE MINUTE after
-- jobid 65 `rpc-allday-ev-corrected-refresh` (cron_heavy, `47 */6` — the same four hours). Both
-- are cron_heavy 600 s jobs and both read heavily; measured 2026-09-18 → 09-19 they die TOGETHER:
--   09-18 00:47/00:48 both 600 s · 09-18 06:47 600 s · 09-19 06:47/06:48 both 600 s ·
--   09-19 12:47/12:48 both 600 s · 09-19 18:47 600 s + 18:48 `job startup timeout` ·
--   09-20 00:47/00:48 both past 300 s at 5:53 PM PT on a box that was io_wait 0 at 5:46 PM.
-- Healthy they take 30–40 s (65) and 36–52 s (324), i.e. they only collide because the schedule
-- puts them on top of each other. The leg's failure is what pins `trust_precompute_max_age_hours`
-- in BREACH (23 h at 5:00 PM PT): its EXCEPTION handler writes 999 and the row ages past 13 h.
--
-- Applied from Cowork cloud 2026-09-19 ~5:55 PM PT. Schedule-only; the command is untouched (the
-- board-MV watchdog matches on command TEXT, and this job is not a board MV anyway).
--
-- Minute chosen from a measured free set, not by hand: over the last 3 days, for hours 0/6/12/18,
-- minute :31 carried the LEAST work of any minute (5 jobs, 9.4 worker-s per tick, max 31 s) and
-- no job has a fixed `31` schedule. Stagger ban (0,1,20,21,40,41) respected. Hours unchanged.
--
-- Same jobname + same owner ⇒ cron.schedule updates in place and jobid 324 is preserved
-- (asserted below). cron.alter_job is unreachable for a cron_heavy-owned job from postgres
-- (the documented pincer), hence SET LOCAL ROLE.
--
-- ✅ Post-apply reading, same minute: the 00:47/00:48Z pair BOTH survived this once (373.9 s and
-- 272.0 s — 5–7× their solo durations), and `trust_precompute_max_age_hours` read 5.09 (ok) at
-- 5:56 PM PT, so the breach is cleared by the run, not by this reschedule; the reschedule is what
-- keeps it cleared.
--
-- EXIT: the 6:31 AM PT (13:31Z) and 12:31 PM PT ticks read `succeeded` in cron.job_run_details and
-- `trust_precompute_max_age_hours` stays under 13.
-- FALSIFIER: a 600 s kill at :31 on a box with io_wait < 3 means the leg's own cost has moved
-- and the collision was never the mechanism.
-- REVERT: SET LOCAL ROLE cron_heavy; SELECT cron.schedule('rpc-thp-leg-impossible-parallel',
--   '48 0,6,12,18 * * *', $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_impossible_parallel()'::regprocedure, 'thp-leg-impossible-parallel');$$);

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
  'rpc-thp-leg-impossible-parallel',
  '31 0,6,12,18 * * *',
  $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_impossible_parallel()'::regprocedure, 'thp-leg-impossible-parallel');$$
);

RESET ROLE;

DO $$
DECLARE v_id int; v_sched text; v_user text;
BEGIN
  SELECT jobid, schedule, username INTO v_id, v_sched, v_user
    FROM cron.job WHERE jobname = 'rpc-thp-leg-impossible-parallel';
  IF v_id IS DISTINCT FROM 324 THEN RAISE EXCEPTION 'jobid changed: %', v_id; END IF;
  IF v_sched <> '31 0,6,12,18 * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user <> 'cron_heavy' THEN RAISE EXCEPTION 'owner changed: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-thp-leg-impossible-parallel') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;
