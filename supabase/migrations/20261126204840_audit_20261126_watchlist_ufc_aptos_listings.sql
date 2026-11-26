-- audit_20261126_watchlist_ufc_aptos_listings
--
-- 2026-11-26 ~12:48 PM PT (Claude Code cloud; Trevor: "Keep going"). Since 11:45 AM PT the UFC sniper
-- (lib/sniper/ufc-aptos.ts) and the concierge UFC floors read ufc_aptos_listings, kept current by the
-- ufc-aptos-listings step of .github/workflows/ufc-aptos-sales-ingest.yml (4x/day, 37 1,7,13,19 UTC).
-- The sniper keeps only asks re-checked in the last 3 days, so if that step stops, /ufc/sniper drains to
-- an empty board with nothing reporting it. arm_unwatched_pipelines() (jobid 675) would not arm this lane
-- until it has 12 days of runs (first run 2026-11-26), so it is armed by hand now.
-- Sizing (measured 11-22..11-26 on the same workflow's sales-ingest lane): max gap 739 min, avg 423 min
-- (GitHub schedule shedding). Silence ceiling 2160 min = 3x the max gap (the auto-arm rule);
-- no-success ceiling 4320 min = the sniper's 3-day re-check window, the point the board goes empty.
-- Severity info, matching auto-armed rows, until a human read promotes it.
--
-- REVERT:
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'ufc-aptos-listings';

INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
VALUES
  ('ufc-aptos-listings', 2160, 4320, 'info', true,
   'Armed by hand 2026-11-26 (12:48 PM PT): feeds /ufc/sniper + concierge UFC floors; sniper keeps asks re-checked in 3 d, so 4320 no-success = board empties. Silence 2160 = 3x max gap 739 min of the shared ufc-aptos-sales-ingest workflow.')
ON CONFLICT (pipeline) DO NOTHING;
