-- audit_20261003_watch_topshot_pack_supply_atlas
--
-- Cadence watch for the Atlas DistributionService lane shipped in 20261003224608.
-- topshot_pack_supply_tick writes a pipeline row on every tick that drained a
-- request — about once a minute while the walk runs (2 requests/min). It writes
-- nothing on a tick it held back for market-lane 403s, so silence of 30 minutes
-- means the lane stopped, not that Atlas was briefly challenging. A run is ok only
-- when every drained request landed; ~8 % of requests fail (403 / 502 / truncated
-- body, each retried), so three hours without one clean run is a real outage.
--
-- Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-pack-supply-atlas';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
VALUES ('topshot-pack-supply-atlas', 30, 180, 'medium',
        'pg_cron rpc-topshot-pack-supply-atlas every minute: Atlas DistributionService walk (list, per-drop summaries, edition pages for drops with packs left) into topshot_atlas_dists / topshot_atlas_dist_editions, <= 2 req/min, held while the market lane is mostly 403s. Feeds get_topshot_issuer_held_split (sealed packs vs reserve). Added 2026-10-03 (20261003224608).',
        true)
ON CONFLICT (pipeline) DO NOTHING;
