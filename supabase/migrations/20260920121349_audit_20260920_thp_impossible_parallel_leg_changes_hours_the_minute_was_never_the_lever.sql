-- ↩↩↩ Third move of jobid 324 `rpc-thp-leg-impossible-parallel` in twelve hours, and the last
-- one this pass will make: `48 0,6,12,18` (7 of 9 ticks killed at 600 s) → `31 0,6,12,18`
-- (20260920005312; first tick killed, io_wait 20) → `59 23,5,11,17` (20260920064646; first tick
-- 2026-09-20 11:59Z killed at 602 s, io_wait 13–15, neighbours refresh-wmc-fmv-changed 415 s,
-- mv-pack-ev-latest 439 s, refresh-perfect-mint-premiums 395 s (`0 */2` — the :00 pile the :59
-- window runs straight into), topshot-pack-rip-values 320 s, market-index-daily 198 s).
-- Every one of those falsifiers read "io_wait > 10 ⇒ the box, and the lever is the hour".
--
-- The hour IS the lever. Busy cron-seconds per hour of day, last 4 days, all jobs but this one:
--   06Z 13,870 · 12Z 12,066 · 18Z 11,523 · 00Z 7,754  — the leg's four hours are the three
--   busiest of the day plus the seventh: every `*/6`, `*/3` and `*/2` job in the estate lands on
--   them. Quietest: 19Z 3,714 · 14Z 4,215 · 15Z 4,219 · 22Z 5,063.
-- Six-hour cadences scored as sets: {1,7,13,19} = 23,029 · {2,8,14,20} = 24,735 ·
--   {3,9,15,21} = 26,631 · {5,11,17,23} = 28,679 · {0,6,12,18} = 45,213.
-- Minute within {1,7,13,19}, scored by other-job seconds overlapping a 300 s window (all runs,
-- including the next hour's, which the earlier :59 analysis did not count): :52 = 642 s/day,
-- :51 = 725, :53 = 779, :50 = 795. The same metric for the slot being left (:59 into 0/6/12/18)
-- is 1,494 s/day; :31 was 3,540; :48 was 4,031. So `52 1,7,13,19` carries 2.3× less cron overlap
-- than the best minute of the old hours, in hours with half the load.
--
-- ⚠ What this does NOT claim: that the slot is the whole story. The leg took 36–96 s on 09-15/16
-- and 272 s at its 5:48 PM PT 09-19 success; under this week's IO (#126, R117) it may not fit
-- 600 s anywhere. If the 13:52Z / 19:52Z ticks still die, the lever is the leg's own read
-- (re-EXPLAIN rpc_thp_leg_impossible_parallel) or #126 — not another minute. Trust arm: the
-- 5:48 PM PT success ages past the 13 h breach at ~6:50 AM PT; the first tick at the new
-- slot is 13:52Z = 6:52 AM PT.
--
-- Same jobname + same owner ⇒ cron.schedule updates in place; jobid 324 asserted below.
-- Applied from Cowork cloud 2026-09-20 ~5:15 AM PT. Schedule-only; command untouched.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: 09-20 13:52Z (6:52 AM PT) and 19:52Z (12:52 PM PT) ticks `succeeded` < 300 s;
--   trust_precompute_max_age_hours back under 13 after the first.
-- FALSIFIER: both killed at 600 s ⇒ stop moving it; the read is the lever (R-row it).
-- REVERT: SET LOCAL ROLE cron_heavy; SELECT cron.schedule('rpc-thp-leg-impossible-parallel',
--   '59 23,5,11,17 * * *', $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_impossible_parallel()'::regprocedure, 'thp-leg-impossible-parallel');$$);

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
  'rpc-thp-leg-impossible-parallel',
  '52 1,7,13,19 * * *',
  $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_impossible_parallel()'::regprocedure, 'thp-leg-impossible-parallel');$$
);

RESET ROLE;

DO $$
DECLARE v_id int; v_sched text; v_user text;
BEGIN
  SELECT jobid, schedule, username INTO v_id, v_sched, v_user
    FROM cron.job WHERE jobname = 'rpc-thp-leg-impossible-parallel';
  IF v_id IS DISTINCT FROM 324 THEN RAISE EXCEPTION 'jobid changed: %', v_id; END IF;
  IF v_sched <> '52 1,7,13,19 * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user <> 'cron_heavy' THEN RAISE EXCEPTION 'owner changed: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-thp-leg-impossible-parallel') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;
