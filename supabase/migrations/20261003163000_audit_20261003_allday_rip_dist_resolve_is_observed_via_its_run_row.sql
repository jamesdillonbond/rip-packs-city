-- 2026-10-03 (PT) — `rpc-allday-resolve-rip-dist-api` (pg_cron jobid 26, hourly :17) is observed
-- through its own pipeline_runs row, and the cadence watchlist arms it. Closes the open row that
-- 20260919182000 seeded as `observed_via = 'none'`: "THIS ROW IS THE OPEN WORK: identify what it
-- writes and wire a freshness bound."
--
-- WHAT IT WRITES, read from the source (supabase/functions/resolve-allday-rip-dist-api/index.ts):
-- `pack_rips.dist_id` for All Day rips whose dist is NULL, named by Dapper's searchPackNft. Its
-- other write, an upsert into `api_probe_debug`, targets a table that DOES NOT EXIST — that write
-- failed silently on every run, which is why 09-19 could not find an outcome table. pack_rips has
-- no write timestamp, and the backlog is 0 of 2,817,117 All Day rips (10-03 ~9:15 AM PT), so an
-- outcome-freshness bound would read stale on a healthy, empty queue. The edge function now writes
-- one log_pipeline_run row per run as `allday-rip-dist-resolve` (ok=true "none" on an empty queue,
-- ok=false on a failed read, lookup or update; rows_written = updates that landed). That row is
-- the observation.
--
-- NUMBERS: hourly cadence -> 180 min silent = 3 missed ticks; 360 min without success. `medium`:
-- visibility only (the estate's convention for a newly armed lane). detect_stalled_pipelines()
-- carries a new-row grace (created_at + max_silent), so this cannot fire before the redeployed
-- function's first rows land.
--
-- Revert:
--   UPDATE public.edge_lane_watch SET observed_via = 'none', pipeline_name = NULL, severity = 'warn',
--     note = 'NO OUTCOME CHECK because I could not identify its target table with confidence on 2026-09-19.'
--     WHERE jobname = 'rpc-allday-resolve-rip-dist-api';
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-rip-dist-resolve';

UPDATE public.edge_lane_watch
   SET observed_via = 'pipeline_runs',
       pipeline_name = 'allday-rip-dist-resolve',
       outcome_table = NULL, outcome_column = NULL, max_age_hours = NULL,
       severity = 'warn',
       note = 'Writes pack_rips.dist_id for All Day rips with a NULL dist (Dapper searchPackNft). Observed via its own pipeline_runs row (allday-rip-dist-resolve), written on every outcome since 2026-10-03; the old api_probe_debug write targeted a table that does not exist. Backlog was 0 of 2.8M on 10-03, so an outcome-freshness bound would read stale on a healthy empty queue. Cadence armed in pipeline_cadence_watchlist (180/360 min).'
 WHERE jobname = 'rpc-allday-resolve-rip-dist-api';

INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
VALUES (
  'allday-rip-dist-resolve', 180, 360, 'medium',
  'Edge fn resolve-allday-rip-dist-api (pg_cron jobid 26, hourly :17): names the dist of All Day rips with a NULL pack_rips.dist_id. One pipeline_runs row per run since 2026-10-03 (ok=true on an empty queue). 180 = 3 missed ticks, 360 without success. medium = visibility.',
  true
)
ON CONFLICT (pipeline) DO NOTHING;

DO $$
BEGIN
  IF (SELECT observed_via FROM public.edge_lane_watch WHERE jobname = 'rpc-allday-resolve-rip-dist-api') <> 'pipeline_runs' THEN
    RAISE EXCEPTION 'edge_lane_watch row not updated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-rip-dist-resolve' AND is_active) THEN
    RAISE EXCEPTION 'cadence watchlist row missing';
  END IF;
END $$;
