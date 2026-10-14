-- 2026-10-14 (PT) — deep-audit D8: wallet_moments_cache metadata has no self-heal
-- outside Top Shot. The scheduled reconciler (jobid 456, reconcile_wmc_metadata_from_editions)
-- is TOP SHOT ONLY by constant, so a wmc row written before its edition/catalog row existed
-- stays blank forever on every other collection. Measured 2026-10-14 ~8:00 AM PT:
--   * rpc_wmc_selfheal_recent(30)  → 247 fillable rows (UFC 145 · TS 66 · AD 27 · Golazos 9),
--     e.g. 9 Golazos rows blank since 09-28 with editions present since 04-14;
--   * backfill_pinnacle_wmc_metadata_from_editions(NULL) → 103 rows: 92 Pinnacle pins with
--     NO name (created 09-29 → 10-14, so the generator is live at ~6/day: the per-wallet
--     post-pass heal runs before the catalog row exists and nothing re-runs it) + 11 catalog
--     title repairs; 0 name REWRITES (dry-run counted before running).
-- Both functions already exist, are pinned (supabase/tests/*.sql) and fill-only; both were run
-- once by hand alongside this migration (backups: audit_20261014_d8_pinnacle_names_backup 103
-- rows, audit_20261014_d8_selfheal_backup 247 rows — old values per wmc_id, RLS on).
-- Cost, measured (EXPLAIN ANALYZE BUFFERS, read side): selfheal 3-day window 44,502 buffers /
-- 115 ms (idx_wmc_metadata_fillable); Pinnacle pass 31,781 buffers / 545 ms (one index scan of
-- the 41k Pinnacle rows). Once a day at a quiet hour (10:3x UTC = 3:3x AM PT; minutes 31/33 are
-- off the stagger ban and off :09 where the Pinnacle FMV writer runs). The Pinnacle command
-- wraps the int-returning function in log_pipeline_run so the lane is observable (R25 class);
-- the estate function logs 'wmc-metadata-selfheal' itself.
-- Exit: the two pipelines log daily and the 30-day candidate count stays near 0.
-- Falsifier: a blank-named Pinnacle pin older than 2 days with a catalog row present.
-- Revert: SELECT cron.unschedule('rpc-wmc-metadata-selfheal-daily');
--         SELECT cron.unschedule('rpc-pinnacle-wmc-names-selfheal-daily');
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('wmc-metadata-selfheal','pinnacle-wmc-names-selfheal');
--         (data: UPDATE wallet_moments_cache from the two backup tables' old_* columns by wmc_id.)

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('wmc-metadata-selfheal', 1560, 'info',
  'pg_cron rpc-wmc-metadata-selfheal-daily (31 10 * * * UTC, postgres) -> rpc_wmc_selfheal_recent(3): fills NULL tier/player/set/mint/team on wmc rows created in the last 3 days from editions, every collection. D8 (2026-10-14). Silence = the daily tick did not run; rows_written 0 is normal.',
  true, 3000)
ON CONFLICT (pipeline) DO NOTHING;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('pinnacle-wmc-names-selfheal', 1560, 'info',
  'pg_cron rpc-pinnacle-wmc-names-selfheal-daily (33 10 * * * UTC, postgres) -> backfill_pinnacle_wmc_metadata_from_editions(NULL) wrapped in log_pipeline_run: names Pinnacle pins whose catalog row arrived after the wallet scan. D8 (2026-10-14). Silence = the daily tick did not run; rows_written 0 is normal.',
  true, 3000)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-wmc-metadata-selfheal-daily', '31 10 * * *', 'SELECT public.rpc_wmc_selfheal_recent(3);');

SELECT cron.schedule('rpc-pinnacle-wmc-names-selfheal-daily', '33 10 * * *',
  $cmd$SELECT public.log_pipeline_run('pinnacle-wmc-names-selfheal', now(), x.n, x.n, 0, true, NULL, 'disney_pinnacle', NULL, NULL, jsonb_build_object('via', 'pg_cron', 'scope', 'collection')) FROM (SELECT public.backfill_pinnacle_wmc_metadata_from_editions(NULL) AS n) x;$cmd$);
