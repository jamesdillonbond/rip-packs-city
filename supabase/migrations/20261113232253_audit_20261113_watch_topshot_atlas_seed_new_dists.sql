-- Stall watch for the 10-minute seed lane (audit_20261113_topshot_atlas_seed_new_dists, pg_cron 874).
-- Every run logs (even 0 seeded): 30/30 ok by 3:22 PM PT 11-13. 35 min silent = 3 missed ticks. info until a human read promotes it.
-- Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-atlas-seed-new-dists';
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
VALUES ('topshot-atlas-seed-new-dists', 35, 70, 'info',
        'pg_cron rpc-ts-atlas-seed-new-dists (jobid 874, 4,14,24,34,44,54 * * * *) -> topshot_atlas_seed_new_dists(): seeds topshot_atlas_dists with Top Shot packs first seen in pack_distributions (7 d) that the daily Atlas list walk has not reached, so summary/pool/EV start within the hour. Logs every run. Added 2026-11-13 (Cowork, Trevor: "Do it all").')
ON CONFLICT (pipeline) DO NOTHING;
