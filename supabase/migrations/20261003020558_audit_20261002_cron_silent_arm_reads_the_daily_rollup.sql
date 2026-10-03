-- audit_20261002_cron_silent_arm_reads_the_daily_rollup
--
-- The `cron_silent` arm of get_pipeline_alerts_core() reads ONLY pipeline_runs (~73 h retention),
-- so a watchlist lane whose threshold exceeds that retention reads "never ran" for most of every
-- period. 20260924182358 fixed exactly this in detect_stalled_pipelines() and
-- detect_pipelines_without_success() and added an 8-day watchlist row for the weekly
-- `wmc-reindex-verify` — but this third reader of the watchlist was not touched. The row's grace
-- clause expired 2026-10-02 and the arm has published, ever since:
--   cron_silent · wmc-reindex-verify · "Last run > 11520 min ago — expected within 11520 min"
-- while cron.job_run_details shows job 442 succeeded 2026-09-27 04:03Z (Sat 09-26 9:03 PM PT;
-- ~5.9 days before this was written) and pipeline_runs_daily holds that run (ok_count 1). That is
-- the 09-24 entry's own falsifier ("any existing lane newly appearing … without a real silence").
--
-- Fix: same rule as 20260924182358 — raw pipeline_runs stays the authority; pipeline_runs_daily
-- (`last_run_at`, refreshed continuously for recent days) is consulted ONLY when raw has no row in
-- the window, so a daily lane's same-day silence is never masked.
--
-- Dry run on live data 2026-10-02 ~7:05 PM PT over the 152 active watchlist rows past their grace:
--   old arm: [wmc-reindex-verify, panini-ingest]   new arm: [panini-ingest]
-- panini-ingest is a REAL silence (residential runner, last run 10:57 AM PT) and stays.
--
-- Spliced from pg_get_functiondef() like 20260923231922 (the function is not pinned); the old text
-- must occur exactly once or the migration refuses.
--
-- anon-exec: unchanged (get_pipeline_alerts_core) — re-created from pg_get_functiondef(), so signature, SECURITY DEFINER, search_path, statement_timeout and ACL are preserved; verified has_function_privilege anon=false, authenticated=false on 2026-10-02.
--
-- Revert: re-run this splice with old/new swapped (the old lateral is quoted verbatim below as old_lat).

DO $mig$
DECLARE
  def     text;
  old_lat text;
  new_lat text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p
   WHERE p.proname = 'get_pipeline_alerts_core'
     AND p.pronamespace = 'public'::regnamespace;

  IF def IS NULL THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core() not found — refusing to splice';
  END IF;

  old_lat := $old$    LEFT JOIN LATERAL (
      SELECT MAX(started_at) AS last_at
      FROM public.pipeline_runs pr
      WHERE pr.pipeline = wl.pipeline
        -- 2026-09-04: the window must cover the threshold, or thresholds > 1440 min clamp to 24 h
        AND pr.started_at > NOW() - GREATEST(INTERVAL '24 hours', wl.max_silent_minutes * INTERVAL '1 minute')
    ) max_run ON true$old$;

  IF (length(def) - length(replace(def, old_lat, ''))) / length(old_lat) <> 1 THEN
    RAISE EXCEPTION 'cron_silent max_run lateral did not appear exactly once in get_pipeline_alerts_core() — refusing to splice';
  END IF;

  new_lat := $new$    LEFT JOIN LATERAL (
      -- 2026-10-02: raw pipeline_runs is the authority; the daily rollup is read ONLY when raw has
      -- no row in the window (a lane whose period outruns raw's ~73 h retention). Same rule as
      -- detect_stalled_pipelines() since 20260924182358.
      SELECT COALESCE(
        (SELECT MAX(pr.started_at)
           FROM public.pipeline_runs pr
          WHERE pr.pipeline = wl.pipeline
            -- 2026-09-04: the window must cover the threshold, or thresholds > 1440 min clamp to 24 h
            AND pr.started_at > NOW() - GREATEST(INTERVAL '24 hours', wl.max_silent_minutes * INTERVAL '1 minute')),
        (SELECT MAX(d.last_run_at)
           FROM public.pipeline_runs_daily d
          WHERE d.pipeline = wl.pipeline
            AND d.last_run_at > NOW() - GREATEST(INTERVAL '24 hours', wl.max_silent_minutes * INTERVAL '1 minute'))
      ) AS last_at
    ) max_run ON true$new$;

  def := replace(def, old_lat, new_lat);
  EXECUTE def;
END
$mig$;
