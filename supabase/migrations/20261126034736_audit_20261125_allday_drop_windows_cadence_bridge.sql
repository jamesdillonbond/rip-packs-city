-- audit_20261125_allday_drop_windows_cadence_bridge
--
-- 2026-11-25 ~8:05 PM PT (Claude Code cloud; Sentinel 7:04 PM PT WARN "Cadence Collapse: allday-drop-windows at 17%
-- of baseline (48/day vs 288)").
--
-- CADENCE: 20261125050221 (11-24 ~9:02 PM PT) repointed job 623 from the dead Studio walk (every 5 min) to
-- refresh_allday_drop_windows_from_atlas() at `23,53 * * * *` (every 30 min). That migration owed a
-- cadence_exempt_lanes bridge (cron-and-schedulers.md: "A GATE that cuts a lane's run rate is a CADENCE CHANGE, and
-- owes its bridge in the same migration") and did not carry one, so the arm reads the planned 288/day -> 48/day
-- change as a collapse and would stay lit until the baseline catches up.
--
-- Lane health at write time: 46 of 46 runs ok since the change (11-24 9:02 PM -> 11-25 7:23 PM PT), each reading
-- 3,201 source rows from atlas_pack_market. Pipeline Silence keeps watching it (watchlist: 60 silent min, set by
-- 20261125050221), so a lane that actually stops still fires there.
--
-- review_by: the arm's baseline is the MEDIAN of runs/day over [today-17, today-3). The first full 30-min day is
-- 11-25; the median falls to the new rate once >= 8 such days (11-25 .. 12-02) are inside the window, i.e. on 12-06.
-- Bridge lapses after 12-06 (same arithmetic as 20261115223136).
--
-- REVERT:
--   DELETE FROM public.cadence_exempt_lanes WHERE pipeline_pattern = 'allday-drop-windows';
INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by) VALUES
  ('allday-drop-windows',
   'Cadence deliberately cut 6x on 2026-11-24 (20261125050221: job 623 moved off the dead Studio GraphQL walk, every 5 min, to refresh_allday_drop_windows_from_atlas() every 30 min). The 14 d baseline median still holds the 5-minute rate, so the arm reads a planned change as a collapse. Bridge only: lapses when the baseline is clean.',
   'Sentinel 2026-11-25 7:04 PM PT: observed 48/day vs baseline 288/day, ratio 0.17 (12h vs 14d at 0.4). 46/46 runs ok since the change, source_rows 3,201 each. First full 30-min day 11-25; median drops once >= 8 such days are inside [today-17, today-3), i.e. from 12-06. Pipeline Silence watchlist for the lane: 60 silent min (20261125050221).',
   DATE '2026-12-06');
