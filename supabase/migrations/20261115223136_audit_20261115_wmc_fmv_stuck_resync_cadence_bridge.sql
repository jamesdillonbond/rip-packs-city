-- audit_20261115_wmc_fmv_stuck_resync_cadence_bridge
--
-- 2026-11-15 ~2:31 PM PT (Claude Code cloud; Sentinel 1:59 PM PT WARN "Cadence Collapse: wmc-fmv-stuck-resync at 33%
-- of baseline (8/day vs 24)").
--
-- CADENCE: 20261115175130 (11-15 ~9:51 AM PT, #248 exit) moved rpc-wmc-fmv-stuck-resync (job 617) from
-- `33 */2 * * *` to daily `33 12 * * *` (4:33 AM PT) and widened its Pipeline Silence watchlist to 1560 / 3000 min.
-- That migration owed a cadence_exempt_lanes bridge (cron-and-schedulers.md: "A GATE that cuts a lane's run rate is a
-- CADENCE CHANGE, and owes its bridge in the same migration") and did not carry one, so the arm reads the planned
-- 24/day -> 1/day change as a collapse and would stay lit for two weeks.
--
-- review_by: the arm's baseline is the MEDIAN of runs/day over [today-17, today-3). The first full daily day is 11-16;
-- the median falls to the daily rate once >= 8 daily days (11-16 .. 11-23) are inside the window, i.e. on 11-27.
-- Bridge lapses on 11-28 (same arithmetic as 20261111191736). Pipeline Silence keeps watching the lane meanwhile.
-- If #248's close-out (11-16) puts 617 back to 2-hourly, delete this row (it then suppresses nothing real anyway).
--
-- REVERT:
--   DELETE FROM public.cadence_exempt_lanes WHERE pipeline_pattern = 'wmc-fmv-stuck-resync';
INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by) VALUES
  ('wmc-fmv-stuck-resync',
   'Cadence deliberately cut 24x on 2026-11-15 (20261115175130, #248 exit: rpc-wmc-fmv-stuck-resync job 617 moved from every 2 h to daily 4:33 AM PT). The 14 d baseline median still holds the 2-hourly rate, so the arm reads a planned change as a collapse. Bridge only: lapses when the baseline is clean.',
   'Sentinel 2026-11-15 1:59 PM PT: observed 8/day vs baseline 24/day, ratio 0.33 (12h vs 14d at 0.4). First full daily day 11-16; median drops once >= 8 daily days are inside [today-17, today-3), i.e. from 11-27. Pipeline Silence watchlist for the lane widened to 1560/3000 min in the same 11-15 migration.',
   DATE '2026-11-28');
