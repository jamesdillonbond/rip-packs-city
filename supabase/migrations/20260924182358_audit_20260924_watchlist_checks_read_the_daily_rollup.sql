-- audit_20260924_watchlist_checks_read_the_daily_rollup
--
-- known-issues #56 (re-read 2026-09-24). detect_stalled_pipelines() and
-- detect_pipelines_without_success() read ONLY pipeline_runs, which keeps ~73 h. A lane whose
-- period is longer than that has no retained row for ~4 of every 7 days, so the stalled check
-- reports it STALLED on a NULL last_run, and the no-success check cannot see its history.
-- Measured on the weekly wmc-reindex-verify (pipeline_runs_daily): its 2026-09-19 PT run FAILED
-- and nothing alerted; it had no watchlist row, and a row would have been a false alarm.
--
-- Fix: when pipeline_runs holds NO row for the lane (purged), fall back to pipeline_runs_daily
-- (indefinite retention, refreshed every 6 h, PK (pipeline, day)). pipeline_runs stays the
-- authority whenever it has rows, so a daily lane's same-day failure is never masked by the
-- day-grain rollup. In the no-success check the fallback is the last run of the newest day with
-- ok_count > 0: an upper bound on that day's last success, used only when no retained success exists.
--
-- Dry run against live data (2026-09-24 8:55 AM PT): the stalled set is [] under both bodies (no
-- existing alarm changes). Positive control, a weekly row for wmc-reindex-verify with 8-day
-- thresholds: old body -> STALLED (false alarm, rows purged); new body -> not stalled, and
-- 16,549 minutes WITHOUT SUCCESS (true: last ok 2026-09-12 PT, the 09-19 PT run failed).
--
-- anon-exec: intentional — CREATE OR REPLACE of the existing SECURITY DEFINER signature keeps its live ACL (service_role + postgres only); the 3-role REVOKE is re-asserted below (detect_stalled_pipelines)
-- anon-exec: intentional — CREATE OR REPLACE of the existing SECURITY DEFINER signature keeps its live ACL (service_role + postgres only); the 3-role REVOKE is re-asserted below (detect_pipelines_without_success)
--
-- Revert: re-apply detect_stalled_pipelines from 20260906215343 and
-- detect_pipelines_without_success from 20260904044756;
-- DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'wmc-reindex-verify';

CREATE OR REPLACE FUNCTION public.detect_stalled_pipelines()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', w.pipeline,
           'severity', w.severity,
           'max_silent_minutes', w.max_silent_minutes,
           'silent_minutes', round((extract(epoch from (now()-lr.last_run))/60)::numeric, 0),
           'last_run', lr.last_run,
           'heartbeat_last_run', hbl.last_hb,
           'uncorrelated_heartbeats', orp.uncorrelated,
           'classification',
             CASE
               WHEN hbl.last_hb IS NULL THEN 'no_marker'
               WHEN (extract(epoch from (now()-hbl.last_hb))/60) <= w.max_silent_minutes
                 THEN 'invoked_but_never_logged'
               ELSE 'not_invoked'
             END,
           'notes', w.notes
         ) ORDER BY (extract(epoch from (now()-lr.last_run))/60) DESC NULLS FIRST), '[]'::jsonb)
  FROM pipeline_cadence_watchlist w
  LEFT JOIN LATERAL (
    -- 2026-09-24: pipeline_runs keeps ~73 h; a lane with no retained row falls back to the daily
    -- rollup, so a weekly lane is not reported stalled merely because its rows were purged.
    SELECT COALESCE(
      (SELECT max(pr.started_at) FROM pipeline_runs pr WHERE pr.pipeline = w.pipeline),
      (SELECT max(d.last_run_at) FROM pipeline_runs_daily d WHERE d.pipeline = w.pipeline)
    ) AS last_run
  ) lr ON true
  LEFT JOIN LATERAL (
    SELECT max(h.started_at) AS last_hb
    FROM pipeline_runs h WHERE h.pipeline = w.pipeline || '-heartbeat'
  ) hbl ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS uncorrelated FROM pipeline_runs h
    WHERE h.pipeline = w.pipeline || '-heartbeat'
      AND h.started_at > COALESCE(lr.last_run, now() - interval '30 days') - interval '5 s'
      AND NOT EXISTS (SELECT 1 FROM pipeline_runs t
                      WHERE t.pipeline = w.pipeline
                        AND t.started_at BETWEEN h.started_at - interval '5 s'
                                             AND h.started_at + interval '5 s')
  ) orp ON true
  WHERE w.is_active
    -- 2026-09-04: a row younger than its own threshold cannot be stalled yet (grace for new pipelines)
    AND w.created_at < now() - (w.max_silent_minutes * interval '1 minute')
    AND (lr.last_run IS NULL OR (extract(epoch from (now()-lr.last_run))/60) > w.max_silent_minutes);
$function$;

CREATE OR REPLACE FUNCTION public.detect_pipelines_without_success()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '8s'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', w.pipeline,
           'severity', w.severity,
           'max_minutes_without_success', w.max_minutes_without_success,
           'minutes_without_success',
             CASE WHEN ls.last_ok IS NULL THEN NULL
                  ELSE round((extract(epoch from (now() - ls.last_ok)) / 60)::numeric, 0) END,
           'age_lower_bound_minutes',
             CASE WHEN ls.last_ok IS NULL AND lr.first_run IS NOT NULL
                  THEN round((extract(epoch from (now() - lr.first_run)) / 60)::numeric, 0) END,
           'last_ok', ls.last_ok,
           'last_run', lr.last_run,
           'runs_retained', lr.runs_retained,
           'notes', w.notes
         ) ORDER BY (extract(epoch from (now() - ls.last_ok)) / 60) DESC NULLS FIRST), '[]'::jsonb)
  FROM pipeline_cadence_watchlist w
  LEFT JOIN LATERAL (
    -- 2026-09-24: no retained success -> the newest daily-rollup day with ok_count > 0 (its
    -- last_run_at is an upper bound on that day's last success; pipeline_runs stays the authority).
    SELECT COALESCE(
      (SELECT max(pr.started_at) FROM pipeline_runs pr WHERE pr.pipeline = w.pipeline AND pr.ok),
      (SELECT max(d.last_run_at) FROM pipeline_runs_daily d WHERE d.pipeline = w.pipeline AND d.ok_count > 0)
    ) AS last_ok
  ) ls ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(max(pr.started_at),
                    (SELECT max(d.last_run_at) FROM pipeline_runs_daily d WHERE d.pipeline = w.pipeline)) AS last_run,
           LEAST(min(pr.started_at),
                 (SELECT min(d.first_run_at) FROM pipeline_runs_daily d WHERE d.pipeline = w.pipeline)) AS first_run,
           count(*) AS runs_retained
    FROM pipeline_runs pr
    WHERE pr.pipeline = w.pipeline
  ) lr ON true
  WHERE w.is_active
    AND w.max_minutes_without_success IS NOT NULL
    -- (a) grace: a row younger than its own threshold cannot have failed it yet
    AND w.created_at < now() - (w.max_minutes_without_success * interval '1 minute')
    AND (
      -- a known last success older than the threshold
      (ls.last_ok IS NOT NULL
       AND (extract(epoch from (now() - ls.last_ok)) / 60) > w.max_minutes_without_success)
      OR
      -- (b) no retained success, and the pipeline has been running (and failing) for longer than the threshold
      (ls.last_ok IS NULL
       AND lr.first_run IS NOT NULL
       AND (extract(epoch from (now() - lr.first_run)) / 60) > w.max_minutes_without_success)
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.detect_stalled_pipelines() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_stalled_pipelines() TO service_role;
REVOKE EXECUTE ON FUNCTION public.detect_pipelines_without_success() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_pipelines_without_success() TO service_role;

-- The weekly reindex verify (Sun 04:03Z, jobid 442): 8 days of slack on both clocks, so one late
-- run is not an alarm but a skipped or failed week is. The grace clause arms it 8 days from now.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
VALUES ('wmc-reindex-verify', 11520, 11520, 'info',
        'Weekly (Sun 04:03Z, jobid 442). Watchable since 20260924: the checks fall back to pipeline_runs_daily when pipeline_runs has purged the lane. The 2026-09-19 PT run failed silently; known-issues #56.',
        true)
ON CONFLICT (pipeline) DO NOTHING;
