-- audit_20261124_panini_new_boards_liveness_arms_and_retired_deals_drop
--
-- 2026-11-24 (Claude Code cloud; Trevor: "work through anything still unresolved from this thread").
--
-- 1. LIVENESS ARMS for the four Panini matviews added 11-23 night. The cadence watches armed then
--    (pipeline_cadence_watchlist) see a refresh that STOPS; they cannot see one that keeps running and writes nothing —
--    exactly how mv_panini_public_deals sat at 0 rows under ok=true runs for days (fixed 20261124050243). The board
--    liveness sweep (public_board_liveness_sweep, jobid 288) counts rows, so these arms catch the collapse. House
--    calibration (2026-08-01): min_rows = 25 % of today's population (a collapse, not churn); these are <2k-row
--    matviews whose count is an index/heap scan in milliseconds, so max_ms = 1000.
--      mv_panini_autographs        1,992 → 498   (a catalogue, never honestly empty)
--      mv_panini_rookie_board      1,918 → 479
--      mv_panini_scarcer_for_less  1,292 → 323
--      mv_panini_serial_premiums     583 → 145
--    NOT armed: mv_panini_public_deals — a deals board can be honestly empty (the 2026-08-01 / 08-30 deactivations of
--    candy_deals_board and topshot_pack_reality_top_ev are the precedent), so min_rows=1 would page on a real market
--    state. Its 11-23 failure was a structural comparison bug, now pinned by __tests__/panini-edition-parity.test.ts.
--
-- 2. DROP mv_panini_public_deals_retired_20261123 — the pre-fix body kept by 20261124050243 for a revert. It has no
--    dependents and no refresher (checked 11-24), and the fix has been live and verified for 10+ hours;
--    its body differed from the live one only in comparing against edition_fmv_current (20261124050243's header).
--
-- REVERT:
--   DELETE FROM public.public_board_liveness_watchlist WHERE view_name IN
--     ('mv_panini_autographs','mv_panini_rookie_board','mv_panini_scarcer_for_less','mv_panini_serial_premiums');
--   (the drop is not revertible in place, and there is nothing to revert to: the old body was empty by construction)

INSERT INTO public.public_board_liveness_watchlist (view_name, min_rows, max_ms, is_active, note)
VALUES
  ('mv_panini_autographs', 498, 1000, true, 'armed 2026-11-24 PT (audit_20261124): 1,992 rows at arm; min_rows = 25% (collapse, not churn). Panini tab of /insights/autographs.'),
  ('mv_panini_rookie_board', 479, 1000, true, 'armed 2026-11-24 PT (audit_20261124): 1,918 rows at arm; min_rows = 25%. Rookie cards tab, /insights/panini-squeeze.'),
  ('mv_panini_scarcer_for_less', 323, 1000, true, 'armed 2026-11-24 PT (audit_20261124): 1,292 rows at arm; min_rows = 25%. Scarcer for less tab, /insights/panini-squeeze.'),
  ('mv_panini_serial_premiums', 145, 1000, true, 'armed 2026-11-24 PT (audit_20261124): 583 rows at arm; min_rows = 25%. #1 / perfect-mint half of /insights/panini-premiums.')
ON CONFLICT (view_name) DO NOTHING;

DROP MATERIALIZED VIEW IF EXISTS public.mv_panini_public_deals_retired_20261123;
