-- audit_20260801_watchlist_pinnacle_sales_and_allday_pack_listings
--
-- CAUSE
-- Two LIVE cron-driven ingest routes had ZERO observability: neither
-- app/api/pinnacle-sales-indexer/route.ts nor app/api/allday-pack-listings/route.ts
-- contained a single log_pipeline_run call, so both were invisible to
-- pipeline_runs, detect_stalled_pipelines() and pipeline_cadence_watchlist.
-- If either silently stopped, nothing would page.
--
-- EVIDENCE (measured live 2026-08-02 ~00:30Z, before this migration)
--   * pipeline_runs: 0 rows have ever existed for either pipeline name.
--   * pinnacle-sales-indexer IS working: 240 pinnacle_sales rows created in the
--     preceding 24h, newest 2026-08-02 00:04:10Z (~8 min before measurement).
--   * allday-pack-listings IS working: 281 pack_listings_cache rows for the
--     AllDay collection, all stamped cached_at 2026-08-02 00:10:38Z.
--   Both facts had to be established from the DESTINATION TABLE, which is
--   exactly the gap this closes. Sibling indexers (allday-sales-indexer,
--   golazos-sales-indexer) on the same ~20-min cron use max_silent_minutes 90.
--
-- WHY is_active = false (IMPORTANT — these are STAGED, not armed)
-- detect_stalled_pipelines() flags a watchlisted pipeline when
--   lr.last_run IS NULL OR silent_minutes > max_silent_minutes
-- so a row added for a pipeline that has NEVER logged is reported as stalled
-- IMMEDIATELY. The route code that emits log_pipeline_run ships separately from
-- this migration, so arming these now would guarantee two false "stalled"
-- entries — polluting the sentinel, v_rpc_trust_health and the daytime
-- monitor's inbox — for the entire window until that deploy lands.
-- They are therefore staged inactive and must be armed AFTER the deploy.
--
-- ARM (run once, after the route change is deployed and each pipeline has
-- logged at least one run; verify first with:
--   SELECT pipeline, max(started_at) FROM pipeline_runs
--    WHERE pipeline IN ('pinnacle-sales-indexer','allday-pack-listings')
--    GROUP BY 1;  -- expect a recent row for BOTH before arming
-- ):
--   UPDATE public.pipeline_cadence_watchlist SET is_active = true
--    WHERE pipeline IN ('pinnacle-sales-indexer','allday-pack-listings');
--
-- REVERT (exact):
--   DELETE FROM public.pipeline_cadence_watchlist
--    WHERE pipeline IN ('pinnacle-sales-indexer','allday-pack-listings');

INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES
  ('pinnacle-sales-indexer', 90, 'medium',
   'On-chain Disney Pinnacle sales ingest, cron-job.org ~every 20 min. 90 min = 4.5 missed ticks, matching the allday/golazos sales-indexer siblings on the same cadence. STAGED INACTIVE: arm only after the log_pipeline_run route change is deployed (see migration header).',
   false),
  ('allday-pack-listings', 90, 'medium',
   'AllDay pack listing cache rebuild (pack_listings_cache), cron-job.org ~every 20 min. Route is after()-based and now emits a synchronous phase:invoked marker plus a phase:complete row, so a dropped after() is distinguishable from a never-invoked route. STAGED INACTIVE: arm only after that route change is deployed (see migration header).',
   false)
ON CONFLICT (pipeline) DO NOTHING;
