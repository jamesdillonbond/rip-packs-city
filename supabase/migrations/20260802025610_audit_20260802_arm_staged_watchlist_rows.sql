-- audit_20260802_arm_staged_watchlist_rows
-- Applied to prod 2026-08-02 02:56 UTC / 2026-08-01 19:56 PT via Supabase MCP.
-- This file is the idempotent repo record.
--
-- Arms the two watchlist rows that
-- audit_20260801_watchlist_pinnacle_sales_and_allday_pack_listings staged with
-- is_active=false. They were staged OFF deliberately: detect_stalled_pipelines()
-- fires when last_run IS NULL, so arming them before their instrumentation had
-- deployed would have manufactured two false stalls.
--
-- Precondition re-measured live before arming:
--   allday-pack-listings   10 runs / 10 ok, max inter-run gap 20 min
--   pinnacle-sales-indexer  5 runs /  5 ok, max inter-run gap 20 min
-- against max_silent_minutes = 90 -> 4.5x headroom. Verified after arming:
-- detect_stalled_pipelines() returned [].
--
-- REVERT:
--   UPDATE public.pipeline_cadence_watchlist SET is_active = false
--    WHERE pipeline IN ('pinnacle-sales-indexer','allday-pack-listings');

UPDATE public.pipeline_cadence_watchlist
   SET is_active = true
 WHERE pipeline IN ('pinnacle-sales-indexer','allday-pack-listings');
