-- audit_20260906_cadence_watchlist_retire_badge_set_backfill_arm_atlas_market_feed
--
-- Two watchlist facts the 2026-09-06 sentinel WARN made visible:
--
-- 1. `topshot-badge-set-backfill` reads as "silent 2769m (info)". It was
--    UNSCHEDULED on 2026-09-04 (the route header says why: it read the dead
--    `public-api.nbatopshot.com`, 0 ok of 12 in 7 days, and the Atlas edition
--    walk writes the same `badge_editions` rows for 266 of 266 sets) — but its
--    cadence-watchlist row was seeded the same morning, BEFORE the retirement,
--    and nobody retired the row with the schedule. A permanently-silent arm on
--    a retired pipeline is the permanently-red instrument CLAUDE.md warns
--    about. Retired here (is_active=false, note kept).
--
-- 2. `atlas-market-feed` (migration 20260906203504) had no arm at all. It runs
--    every 2 minutes and writes a pipeline_runs row on every drain that had a
--    request to process. Cloudflare's challenge on this egress can hold at
--    100 % for ~4 minutes after a burst (measured 09-06), so the silence bar is
--    20 min (ten missed ticks) and the no-success bar 45 min; a full firehose
--    page spans ~50 min of events, so nothing is lost inside that bar.
--
-- Revert: UPDATE ... SET is_active = true WHERE pipeline = 'topshot-badge-set-backfill';
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'atlas-market-feed';

UPDATE public.pipeline_cadence_watchlist
   SET is_active = false,
       notes = COALESCE(notes, '') || ' | RETIRED 2026-09-06: the route was unscheduled 2026-09-04 (dead host; redundant with the Atlas edition walk) and this row outlived its schedule — it read "silent 2769m" on the 09-06 sentinel.'
 WHERE pipeline = 'topshot-badge-set-backfill';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('atlas-market-feed', 20, 'medium',
        'Armed 2026-09-06 with the feed (migration 20260906203504): pg_cron drain every 2 min, a pipeline_runs row per drain that had a request. Silence 20 min = ten missed ticks; no-success 45 min covers a Cloudflare challenge burst (~4 min at 100%, measured 09-06). Freshness truth is max(listed_at) on topshot_atlas_market_events.',
        true, 45)
ON CONFLICT (pipeline) DO UPDATE
   SET max_silent_minutes = EXCLUDED.max_silent_minutes,
       severity = EXCLUDED.severity,
       notes = EXCLUDED.notes,
       is_active = true,
       max_minutes_without_success = EXCLUDED.max_minutes_without_success;
