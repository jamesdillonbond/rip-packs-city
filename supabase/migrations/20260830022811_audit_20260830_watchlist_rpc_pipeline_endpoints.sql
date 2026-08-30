-- audit_20260830_watchlist_rpc_pipeline_endpoints
-- Applied to prod 2026-08-30 ~02:4x UTC / 2026-08-29 ~19:4x PT via Supabase MCP.
-- This file is the idempotent repo record.
--
-- Register R68. The six endpoints .github/workflows/rpc-pipeline.yml calls now
-- write pipeline_runs rows (commit 9fbb91637); before that, four of them wrote
-- nothing at all, which is why only `fmv-recalc` was ever watchlisted. Durable
-- rows are DATA, not detection — this is the arming step that turns them into
-- detection.
--
-- ⚠ PRECONDITION RE-MEASURED LIVE BEFORE ARMING, per the trap this table's own
-- 2026-08-02 migration records: detect_stalled_pipelines() fires when
-- last_run IS NULL, so arming a row before its instrumentation has produced any
-- row manufactures a false stall. Verified 2026-08-30 02:20-02:21Z, one full
-- workflow tick after the deploy — every one of the five has a row:
--   ingest                 ok=false  (Top Shot GraphQL 530 — a REAL failure the
--                                     old setup could not have shown: the route
--                                     returns 202 from after(), so the workflow
--                                     saw 200 and no row existed)
--   ingest-heartbeat       ok=true
--   fmv-backfill           ok=true   rows_found 0 / written 0 (measured zero)
--   backfill               ok=true   stage already_complete, counters NULL
--   backfill-player-names  ok=true   edge fn 200, counters NULL
--   price-snapshots        ok=true   rows_written 71
--
-- ⚠ THE THRESHOLD IS FROM A MEASURED DISTRIBUTION, NOT THE NOMINAL SCHEDULE.
-- The workflow is cron'd 3x/hour but is heavily shed (register R61). Measured
-- over the 30 scheduled runs GitHub still lists, 2026-08-26 -> 08-30:
--   inter-run gap  median 1.81h · p90 9.92h · MAX 11.35h
--   runs per UTC day  18, 2, 3, 6, 1  (erratic, not a flat cap)
-- 1800 minutes = 30h is 2.6x the observed max gap.
--
-- ⚠ 1800 IS ALSO A CEILING, NOT JUST A CHOICE. The sentinel's "Pipeline Success
-- Coverage" arm reads a 24-48h window and its comment states the invariant that
-- the window must stay wider than the slowest watchlisted cadence — 1800 is the
-- longest max_silent_minutes on the active watchlist today, so these rows sit at
-- that bound and do not break it. Anything longer would make the arm flap.
--
-- ⚠ SEVERITY IS DELIBERATELY BELOW `high`. High-severity stalls PAGE, and this
-- repo has already learned what a permanently-noisy instrument costs. These are
-- reported, not escalated, until the cadence has been measured over a full week
-- of rows rather than four days of GitHub's run listing.
--
-- REVERT:
--   DELETE FROM public.pipeline_cadence_watchlist
--    WHERE pipeline IN ('ingest','fmv-backfill','backfill',
--                       'backfill-player-names','price-snapshots');

INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES
  ('ingest', 1800, 'medium',
   'Top Shot sales ingest, called by .github/workflows/rpc-pipeline.yml (cron 5,25,45 but heavily shed — see R61). Instrumented 2026-08-30 (R68): writes ingest-heartbeat before the after() body and a terminal ingest row after it, so a maxDuration kill is readable by correlation. Threshold 1800m = 2.6x the measured max inter-run gap of 11.35h (30 scheduled runs, 08-26..08-30). RE-DERIVE after a full week of rows.',
   true),
  ('fmv-backfill', 1800, 'info',
   'Covers editions with sales but no FMV snapshot. Called by rpc-pipeline.yml. Instrumented 2026-08-30 (R68) — terminal row on every exit path past auth. Writes a MEASURED rows_found/rows_written 0 when caught up, and NULL counters on failure paths. Same 1800m basis as ingest.',
   true),
  ('backfill', 1800, 'info',
   'Historical Top Shot sales walk. Called by rpc-pipeline.yml. Instrumented 2026-08-30 (R68). ⚠ Its walk-failure path returns HTTP 200 with {"ok":false}, so the workflow status check cannot see it — pipeline_runs.ok is the only place that failure is visible. Currently status=complete, so healthy ticks log stage=already_complete with NULL counters. Same 1800m basis as ingest.',
   true),
  ('backfill-player-names', 1800, 'info',
   'Thin proxy to the deploy-only backfill-player-names edge function. Called by rpc-pipeline.yml. Instrumented 2026-08-30 (R68). ⚠ Counters are ALWAYS NULL by design — the route measures nothing itself; what it records is that the invocation happened and whether the edge function answered. Same 1800m basis as ingest.',
   true),
  ('price-snapshots', 1800, 'medium',
   'Hourly OHLC bucket writer (populate_price_snapshots_hourly). Called by rpc-pipeline.yml. Instrumented 2026-08-30 (R68) — its workflow step previously captured NO status code at all, so a 504 under pooler saturation (the documented failure for this endpoint, which had already cost 7 of 24 hourly buckets) was indistinguishable from a healthy hour. rows_written is read from the RPC return, not guarded with ?? 0. Same 1800m basis as ingest.',
   true)
ON CONFLICT (pipeline) DO UPDATE
  SET max_silent_minutes = EXCLUDED.max_silent_minutes,
      severity           = EXCLUDED.severity,
      notes              = EXCLUDED.notes,
      is_active          = EXCLUDED.is_active;
