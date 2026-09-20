-- ⚠ SUPERSEDED 38 seconds later by 20260920064646 (:59). Committed because it was APPLIED;
-- the DO block below passed at apply time and the :16 schedule was live for under a minute.
-- Kept verbatim so the parity guard and the record agree.
--
-- ↩ Corrects 20260920005312, which moved jobid 324 `rpc-thp-leg-impossible-parallel` (cron_heavy)
-- from `48 0,6,12,18` to `31 0,6,12,18` on the strength of a "measured free set" that counted
-- jobs STARTING at each minute (":31 carried the least work — 5 jobs, 9.4 worker-s per tick").
-- That is the wrong measure for a slot: what kills a 600 s job is what is RUNNING across its
-- minutes, not what starts on them. The first tick at the new slot, 2026-09-19 11:31:30 PM PT
-- (06:31Z), died at 608 s with io_wait 20 and no vacuum running; the falsifier the earlier
-- header set (a kill with io_wait < 3) did NOT fire — the box was saturated, and it was
-- saturated by the slot: pack-grail-metrics-mv (:23, 509 s), remap-misattributed-sales
-- (:23 */6, 508 s), candy-scarcity-board (:26, 326 s), public-board-liveness-sweep
-- (28 0,6,11,20 — the same hours, 374 s), pack-reality-stats (30 */2 — EVERY one of the leg's
-- four hours is even, 293 s), refresh-wmc-fmv-changed (:27 and :37, 373/249 s), mv-pack-ev-latest
-- (:33, 590+ s), pack-reality-top-ev (34 */2, 246 s), allday-pack-realized (35 */6, 465+ s).
-- Coverage over the last 4 days, hours 0/6/12/18, jobs ≥ 60 s: minute :31 is covered by 57
-- busy-job-minutes (avg 3.6 concurrent) — among the worst ten minutes of the hour; :48 was 53.
--
-- Free set by COVERAGE, same window: :17 = 23, :18 = 26, :16 = 27, :15 = 30 (:00/:01 are lower
-- but stagger-banned). Per hour at :16 the residents are refresh-market-index-daily (in every
-- hour, :13–:17), the 2-minute atlas lanes, wmc-metadata-reconcile (:15, ~75 s) and — from :17 —
-- refresh-wmc-fmv-changed's 7-57/10 tick, which no minute of the hour escapes for long. The
-- next pile starts at :19 (backfill-pinnacle-mint-acquisitions, 19 */3, 600–900 s, hits all
-- four hours). The leg takes 36–96 s healthy (09-15 → 09-18 ticks), so a :16 start clears
-- before :19 in the healthy case and gets a one-minute head start on jobid 303.
--
-- Same jobname + same owner ⇒ cron.schedule updates in place; jobid 324 asserted below.
-- Applied from Cowork cloud 2026-09-19 11:5x PM PT. Schedule-only; command untouched.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: the 5:16 AM PT (12:16Z) and 11:16 AM PT ticks on 09-20 read `succeeded` in
--   cron.job_run_details with duration < 200 s; `trust_precompute_max_age_hours` stays < 13.
-- FALSIFIER: a 600 s kill at :16 while io_wait < 3 and the :16 coverage still reads < 30
--   ⇒ the leg's own cost moved (re-EXPLAIN rpc_thp_leg_impossible_parallel); a kill with
--   io_wait > 10 ⇒ the box, and the next lever is the hour, not the minute.
-- REVERT: SET LOCAL ROLE cron_heavy; SELECT cron.schedule('rpc-thp-leg-impossible-parallel',
--   '31 0,6,12,18 * * *', $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_impossible_parallel()'::regprocedure, 'thp-leg-impossible-parallel');$$);

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
  'rpc-thp-leg-impossible-parallel',
  '16 0,6,12,18 * * *',
  $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_impossible_parallel()'::regprocedure, 'thp-leg-impossible-parallel');$$
);

RESET ROLE;

DO $$
DECLARE v_id int; v_sched text; v_user text;
BEGIN
  SELECT jobid, schedule, username INTO v_id, v_sched, v_user
    FROM cron.job WHERE jobname = 'rpc-thp-leg-impossible-parallel';
  IF v_id IS DISTINCT FROM 324 THEN RAISE EXCEPTION 'jobid changed: %', v_id; END IF;
  IF v_sched <> '16 0,6,12,18 * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user <> 'cron_heavy' THEN RAISE EXCEPTION 'owner changed: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-thp-leg-impossible-parallel') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;
