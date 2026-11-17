-- Calibration data for the correlated-skip arm that inbox 2026-09-03T0300Z sketched and
-- deliberately did NOT ship: "45 scheduled pipelines skipped 66 ticks inside one two-hour band,
-- and no alert on this platform could fire". Its stated blocker is that a threshold needs a
-- calibration pass over more than one event, and pipeline_runs retains ~73 h while
-- pipeline_runs_daily is six-hourly and cannot resolve a 40-minute band.
--
-- This persists, once an hour, the per-pipeline gap profile the filing derives:
--   scheduled  = pipelines with >= 20 gaps in the trailing 73 h whose p90/p10 <= 1.25 (derived,
--                never a list — the filing's load-bearing filter; drop it and the count is 11,504)
--   skipped    = for each gap ending inside the hour that exceeds 1.5x the pipeline's own median,
--                round(gap / median) - 1 missed ticks
-- Per-pipeline rows are kept only where something happened (skipped > 0, or silent with >= 1
-- tick expected); a '_all_' summary row is written for EVERY hour so the series has no holes.
-- Re-aggregates the last p_hours COMPLETE hours each run (idempotent upsert), so a missed tick
-- of this rollup self-heals on the next one as long as p_hours > 1.
--
-- NOT an alarm. Nothing reads this yet. The arm comes after the table holds enough events to
-- put a line somewhere defensible — the filing says one sample cannot.
CREATE TABLE IF NOT EXISTS public.pipeline_gap_hourly (
  hour timestamptz NOT NULL,
  pipeline text NOT NULL,
  p50_gap_min numeric,
  expected_ticks numeric,
  ticks integer NOT NULL,
  max_gap_min numeric,
  skipped_ticks integer NOT NULL,
  scheduled_pipelines integer,
  pipelines_with_skips integer,
  silent_pipelines integer,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hour, pipeline)
);
ALTER TABLE public.pipeline_gap_hourly ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_gap_hourly FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pipeline_gap_hourly TO service_role;

CREATE OR REPLACE FUNCTION public.rollup_pipeline_gaps(p_hours integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_from     timestamptz := date_trunc('hour', now()) - make_interval(hours => GREATEST(p_hours, 1));
  v_to       timestamptz := date_trunc('hour', now());   -- exclusive: complete hours only
  v_upserted bigint;
BEGIN
  WITH runs AS (
    SELECT pipeline, started_at,
           extract(epoch FROM (started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at))) / 60.0 AS gap_min
    FROM public.pipeline_runs
    WHERE started_at >= now() - interval '73 hours'
  ),
  prof AS (
    SELECT pipeline, count(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_min) AS p50,
           percentile_cont(0.1) WITHIN GROUP (ORDER BY gap_min) AS p10,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY gap_min) AS p90
    FROM runs
    WHERE gap_min IS NOT NULL
    GROUP BY 1
  ),
  sched AS (
    SELECT pipeline, p50 FROM prof WHERE n >= 20 AND p10 > 0 AND p90 / p10 <= 1.25
  ),
  hours AS (
    SELECT generate_series(v_from, v_to - interval '1 hour', interval '1 hour') AS hour
  ),
  cell AS (
    SELECT h.hour, s.pipeline, s.p50,
           60.0 / s.p50 AS expected_ticks,
           count(r.started_at)::int AS ticks,
           max(r.gap_min) AS max_gap_min,
           coalesce(sum(CASE WHEN r.gap_min > 1.5 * s.p50 THEN GREATEST(0, round(r.gap_min / s.p50) - 1) ELSE 0 END), 0)::int AS skipped_ticks
    FROM hours h
    CROSS JOIN sched s
    LEFT JOIN runs r ON r.pipeline = s.pipeline AND r.started_at >= h.hour AND r.started_at < h.hour + interval '1 hour'
    GROUP BY h.hour, s.pipeline, s.p50
  ),
  keep AS (
    SELECT hour, pipeline, p50 AS p50_gap_min, expected_ticks, ticks, max_gap_min, skipped_ticks,
           NULL::int AS scheduled_pipelines, NULL::int AS pipelines_with_skips, NULL::int AS silent_pipelines
    FROM cell
    WHERE skipped_ticks > 0 OR (ticks = 0 AND expected_ticks >= 1)
    UNION ALL
    SELECT hour, '_all_', NULL, sum(expected_ticks), sum(ticks)::int, max(max_gap_min), sum(skipped_ticks)::int,
           count(*)::int,
           count(*) FILTER (WHERE skipped_ticks > 0)::int,
           count(*) FILTER (WHERE ticks = 0 AND expected_ticks >= 1)::int
    FROM cell
    GROUP BY hour
  )
  INSERT INTO public.pipeline_gap_hourly AS g
    (hour, pipeline, p50_gap_min, expected_ticks, ticks, max_gap_min, skipped_ticks,
     scheduled_pipelines, pipelines_with_skips, silent_pipelines, computed_at)
  SELECT hour, pipeline, p50_gap_min, expected_ticks, ticks, max_gap_min, skipped_ticks,
         scheduled_pipelines, pipelines_with_skips, silent_pipelines, now()
  FROM keep
  ON CONFLICT (hour, pipeline) DO UPDATE SET
    p50_gap_min          = EXCLUDED.p50_gap_min,
    expected_ticks       = EXCLUDED.expected_ticks,
    ticks                = EXCLUDED.ticks,
    max_gap_min          = EXCLUDED.max_gap_min,
    skipped_ticks        = EXCLUDED.skipped_ticks,
    scheduled_pipelines  = EXCLUDED.scheduled_pipelines,
    pipelines_with_skips = EXCLUDED.pipelines_with_skips,
    silent_pipelines     = EXCLUDED.silent_pipelines,
    computed_at          = now();

  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  -- Its own terminal row, so the rollup is a watched pipeline and not a silent one.
  -- NOTE: duration_ms is GENERATED on pipeline_runs -- never list it here.
  INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, rows_written, ok, extra)
  VALUES ('pipeline-gap-hourly-rollup', v_started, clock_timestamp(), v_upserted::int, true,
          jsonb_build_object('hours', p_hours, 'from', v_from, 'to', v_to, 'upserted', v_upserted));

  RETURN jsonb_build_object('upserted', v_upserted, 'from', v_from, 'to', v_to);
END;
$fn$;

REVOKE ALL ON FUNCTION public.rollup_pipeline_gaps(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollup_pipeline_gaps(integer) TO service_role;

-- Hourly at :07 — after the top-of-hour crons have written their rows for the previous hour.
SELECT cron.schedule('rpc-pipeline-gap-hourly-rollup', '7 * * * *', $job$SELECT public.rollup_pipeline_gaps(3)$job$);