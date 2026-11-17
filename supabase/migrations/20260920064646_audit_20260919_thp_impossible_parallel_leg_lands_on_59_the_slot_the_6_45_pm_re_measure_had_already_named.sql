-- ↩↩ Supersedes 20260920064608 (applied 38 s earlier, which moved jobid 324 to :16) — and
-- corrects 20260920005312 (:31). The cron-schedule.md row for this job already carried the
-- better analysis, written by another session at 6:45 PM PT: scoring every minute by OTHER-job
-- seconds overlapping a 300 s window (the leg ran 272 s at its last success) on hours 0/6/12/18,
-- :59 = 7,256 s, :58 = 8,291, :00 = 8,803, :01 = 8,898, :31 = 13,912, :48 = 16,311 — and it said
-- "if :31 still breaches, :59 is the measured next candidate". :31 breached on its first tick
-- (11:31:30 PM PT, 608 s, io_wait 20, no vacuum). The :16 pick minutes ago used a 1-minute
-- coverage metric that is right for a 60 s job and wrong for this one: the :19 tick of
-- backfill-pinnacle-mint-acquisitions (19 */3, 600–900 s) lands inside any :16 + 300 s window in
-- all four hours. Per-minute coverage for :59 → :04 is the lowest of the hour by my own measure
-- too (:00 = 14, :01 = 15, :02 = 21, :03 = 23 busy-job-minutes over 4 days vs :31 = 57).
-- Stagger ban covers START minutes 0,1,20,21,40,41 — :59 is not banned and its window is
-- exactly the trough the ban created.
--
-- Same jobname + same owner ⇒ cron.schedule updates in place; jobid 324 asserted below.
-- Applied from Cowork cloud 2026-09-19 11:5x PM PT. Schedule-only; command untouched.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: the 4:59 AM PT (11:59Z) and 10:59 AM PT ticks on 09-20 read `succeeded` under 200 s;
--   `trust_precompute_max_age_hours` stays < 13 (the 5:48 PM PT success ages past 13 h at
--   ~6:50 AM PT, so the 4:59 AM tick is the one that matters).
-- FALSIFIER: a 600 s kill at :59 with io_wait < 3 ⇒ the leg's own cost (re-EXPLAIN
--   rpc_thp_leg_impossible_parallel); with io_wait > 10 ⇒ the box, and the lever is the hour.
-- REVERT: SET LOCAL ROLE cron_heavy; SELECT cron.schedule('rpc-thp-leg-impossible-parallel',
--   '31 0,6,12,18 * * *', $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_impossible_parallel()'::regprocedure, 'thp-leg-impossible-parallel');$$);

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
  'rpc-thp-leg-impossible-parallel',
  '59 23,5,11,17 * * *',
  $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_impossible_parallel()'::regprocedure, 'thp-leg-impossible-parallel');$$
);

RESET ROLE;

DO $$
DECLARE v_id int; v_sched text; v_user text;
BEGIN
  SELECT jobid, schedule, username INTO v_id, v_sched, v_user
    FROM cron.job WHERE jobname = 'rpc-thp-leg-impossible-parallel';
  IF v_id IS DISTINCT FROM 324 THEN RAISE EXCEPTION 'jobid changed: %', v_id; END IF;
  IF v_sched <> '59 23,5,11,17 * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user <> 'cron_heavy' THEN RAISE EXCEPTION 'owner changed: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-thp-leg-impossible-parallel') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;
