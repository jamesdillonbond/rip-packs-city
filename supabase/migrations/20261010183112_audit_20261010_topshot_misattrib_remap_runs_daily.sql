-- audit_20261010_topshot_misattrib_remap_runs_daily
--
-- 2026-10-10 (known-issues #101). resolve_topshot_misattrib_via_atlas (20261010182920) now fills
-- topshot_misattrib_onchain_map continuously; remap_topshot_from_onchain_map() is its consumer
-- (re-keys sales + free-slot moments, both audited, parallel-fold guarded) and had no schedule.
-- First manual run 2026-10-10 ~11:31 AM PT: 14 sales + 5 moments re-keyed over a 49,485-row map,
-- exactly the 14 the dry-run predicted (old map rows: 0 changes). Daily at 12:33 UTC (5:33 AM PT).
-- Its failures are visible through check_pgcron_recent_failures (it writes no pipeline_runs row).
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-misattrib-remap');

SELECT cron.schedule('rpc-topshot-misattrib-remap', '33 12 * * *', 'SELECT public.remap_topshot_from_onchain_map();');
