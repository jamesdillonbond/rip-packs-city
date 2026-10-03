-- audit_20261003: check_correlated_tick_loss() — the fleet dip no per-pipeline arm can see.
--
-- WHY (register R77, filed 2026-09-03). On 2026-09-01 04:00–06:00Z, 28 then 16
-- clock-driven pipelines each missed a tick and NOTHING alerted: every gap was
-- shorter than that pipeline's own `max_silent_minutes`, so `cron_silent` and
-- `detect_stalled_pipelines()` stayed quiet. Every HTTP-side arm is PER PIPELINE
-- and therefore blind to a dip that is small per lane and large across the fleet.
-- `get_pipeline_alerts_core` already carries this shape for pg_cron
-- (`pgcron_startup_timeout`, ≥5 correlated launch failures in 30 min); nothing
-- did for the pipelines' own run rows.
--
-- WHAT IT MEASURES. A pipeline is "on a clock" when its own 72 h history says so —
-- ≥20 gaps and p90/p10 gap ≤ 1.25 — a property of the data, never a curated list
-- (event-driven lanes like wallet-backfill fail the ratio; treating them as
-- scheduled is what produced the refuted "118 pipelines, 11,504 ticks" reading in
-- the original filing). A miss is a gap > 1.5 × that pipeline's median, dated to
-- the hour the first missed tick was DUE (gap start + median), not the hour the
-- next run landed — so a 7 h outage's misses land in the hour it began.
-- Returns, per due-hour in p_recent, the count of DISTINCT clock pipelines that
-- missed (distinct, so one chronically-missing lane counts once, not N times).
--
-- CALIBRATION (the R77 exit condition: "needs a calibration, not this sample").
-- Two independent quiet windows, same definition:
--   2026-08-31..09-03 (the filing): ≤5 pipelines in every hour but the event.
--   2026-09-30..10-03 (this file):  132 clock pipelines, 70 h, p50 1 / p99 3 / MAX 3.
-- Real events: 09-01 band 28 and 16; 09-18 outage (#122) 116.
-- → warn_at 10 (seeded below, tunable): 2× the worst quiet hour seen in either
--   window, ~1.6× below the smallest real event. Never critical: it is a
--   post-hoc report (a miss is only knowable once the next run lands).
--
-- COST, measured before writing: one index-only walk of 72 h of pipeline_runs on
-- pipeline_runs_pipeline_started_idx, ~7,500 shared buffers, 168 ms.
--
-- Reader: lib/sentinel/correlated-tick-loss.ts → sentinel arm "Correlated Tick Loss".
--
-- REVERT:
--   DROP FUNCTION IF EXISTS public.check_correlated_tick_loss(interval, interval);
--   DELETE FROM public.sentinel_threshold_config WHERE check_name = 'Correlated Tick Loss';

CREATE OR REPLACE FUNCTION public.check_correlated_tick_loss(
  p_recent interval DEFAULT '3 hours',
  p_history interval DEFAULT '72 hours'
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (
    SELECT pipeline,
           started_at,
           extract(epoch FROM started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at)) AS gap
    FROM pipeline_runs
    WHERE started_at > now() - p_history
      AND pipeline NOT LIKE '%heartbeat%'
  ),
  clock AS (
    SELECT pipeline, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS med
    FROM r
    WHERE gap IS NOT NULL
    GROUP BY pipeline
    HAVING count(*) >= 20
       AND percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)
           / nullif(percentile_cont(0.1) WITHIN GROUP (ORDER BY gap), 0) <= 1.25
  ),
  miss AS (
    SELECT date_trunc('hour', r.started_at - make_interval(secs => r.gap) + make_interval(secs => c.med)) AS due_hour,
           r.pipeline,
           greatest(round(r.gap / c.med) - 1, 1)::int AS ticks
    FROM r
    JOIN clock c USING (pipeline)
    WHERE r.gap > 1.5 * c.med
  ),
  per AS (
    SELECT due_hour,
           count(DISTINCT pipeline) AS pipelines,
           sum(ticks) AS ticks,
           (array_agg(DISTINCT pipeline ORDER BY pipeline))[1:8] AS sample
    FROM miss
    WHERE due_hour >= date_trunc('hour', now() - p_recent)
    GROUP BY due_hour
  )
  SELECT jsonb_build_object(
    'clock_pipelines', (SELECT count(*) FROM clock),
    'recent', p_recent::text,
    'history', p_history::text,
    'hours', coalesce(
      (SELECT jsonb_agg(jsonb_build_object(
                'due_hour', due_hour,
                'pipelines', pipelines,
                'ticks', ticks,
                'sample', to_jsonb(sample))
              ORDER BY pipelines DESC, due_hour DESC)
       FROM per),
      '[]'::jsonb)
  );
$function$;

COMMENT ON FUNCTION public.check_correlated_tick_loss(interval, interval) IS
  'Sentinel "Correlated Tick Loss" arm (R77): per due-hour in p_recent, the count of DISTINCT clock-driven pipelines (>=20 gaps and p90/p10 <= 1.25 over p_history) that missed a tick (gap > 1.5x own median). ~7,500 buffers per call. Reader: lib/sentinel/correlated-tick-loss.ts.';

-- anon-exec: revoked (check_correlated_tick_loss) — new SECDEF ops probe; service_role and postgres only, like check_wall_kills.
REVOKE EXECUTE ON FUNCTION public.check_correlated_tick_loss(interval, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_correlated_tick_loss(interval, interval) TO postgres, service_role;

INSERT INTO public.sentinel_threshold_config (check_name, warn_at, crit_at, enabled, note)
VALUES
  ('Correlated Tick Loss', 10, NULL, true,
   'warn when >= warn_at distinct clock-driven pipelines missed a tick DUE in the same hour (last 3 h). Calibrated 2026-10-03 on two quiet windows (max 5 on 08-31..09-03, max 3 on 09-30..10-03) against real events of 16/28 (09-01) and 116 (09-18, #122). Never critical: a miss is only knowable once the next run lands, so this is a post-hoc report. Register R77.')
ON CONFLICT (check_name) DO NOTHING;
