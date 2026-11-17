-- Seed cadence-watchlist arms for every pipeline that had NONE — decided 2026-09-03 under Trevor's
-- delegation ("RPC long term and our users"). The gap `sales-serial-backfill` sat in for a month
-- (12 ticks/day, ok=true, zero watched) was not one pipeline's problem: ~40 real pipelines with
-- 12+ active days in the last 14 had no arm at all (inbox 2026-09-04T0220Z §2).
--
-- DERIVED, NEVER A LIST. Each arm is sized from the pipeline's own 73 h gap profile at apply time:
--   max_silent_minutes           = greatest(60, 3 x max observed gap between ANY two runs)
--   max_minutes_without_success  = greatest(2 x silent, 3 x max observed gap between OK runs),
--                                  or NULL (not armed) when the pipeline had no OK run in the window —
--                                  arming no-success on a pipeline that never succeeds would fire at
--                                  once and stay red with its clearing condition outside the estate.
-- Excluded by rule: `-heartbeat` markers (the terminal name is the watched one), DB-internal names
-- (refresh_wmc_fmv_*, promote_unmapped_sales, the rollups), pipelines already on the list, anything
-- with fewer than 12 active days or no run yesterday/today, and sync-nba-projections (#8, dead
-- upstream, cron-job.org schedule is Trevor's).
--
-- SEVERITY `info` FOR ALL OF THEM: the sentinel pages only on `high`; `info` stalls appear in its
-- WARN list and in get_pipeline_alerts() — visibility first, promotion to medium/high is a human
-- read of the first weeks. detect_stalled_pipelines() already grants a new row a grace period of
-- its own threshold, so nothing fires on apply. The 08-29 flap measurement (21 of 83 arms under a
-- naive ok-filter) is why the no-success arm is 3x the pipeline's OWN ok-gap, never a constant.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
WITH recent AS (
  SELECT pipeline, sum(runs) AS runs, sum(ok_count) AS ok_runs, count(DISTINCT day) AS days, max(day) AS last_day
  FROM public.pipeline_runs_daily
  WHERE day >= current_date - 14
  GROUP BY 1
),
unwatched AS (
  SELECT r.*
  FROM recent r
  LEFT JOIN public.pipeline_cadence_watchlist w ON w.pipeline = r.pipeline
  WHERE w.pipeline IS NULL
    AND r.days >= 12
    AND r.last_day >= current_date - 1
    AND r.pipeline NOT LIKE '%-heartbeat'
    AND r.pipeline NOT IN ('promote_unmapped_sales','refresh_wmc_fmv_changed','refresh_wmc_fmv_drift_active',
                           'pipeline-runs-daily-rollup','pipeline-gap-hourly-rollup','sync-nba-projections')
),
gaps AS (
  SELECT pipeline, ok,
         extract(epoch FROM (started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at))) / 60 AS gap_min
  FROM public.pipeline_runs
  WHERE pipeline IN (SELECT pipeline FROM unwatched)
),
prof AS (
  SELECT pipeline, ceil(max(gap_min))::int AS max_gap FROM gaps WHERE gap_min IS NOT NULL GROUP BY 1
),
okgaps AS (
  SELECT pipeline, ceil(max(g))::int AS max_ok_gap
  FROM (
    SELECT pipeline, extract(epoch FROM (started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at))) / 60 AS g
    FROM public.pipeline_runs
    WHERE ok AND pipeline IN (SELECT pipeline FROM unwatched)
  ) x
  WHERE g IS NOT NULL
  GROUP BY 1
)
SELECT u.pipeline,
       greatest(60, 3 * p.max_gap) AS max_silent_minutes,
       CASE WHEN o.max_ok_gap IS NULL THEN NULL
            ELSE greatest(2 * greatest(60, 3 * p.max_gap), 3 * o.max_ok_gap) END AS max_minutes_without_success,
       'info' AS severity,
       true AS is_active,
       format('Seeded 2026-09-04 from the 73 h gap profile at apply time: %s runs / %s ok in 14 d, max gap %s min, max ok-gap %s. info until a human read of the first weeks promotes it; no-success left NULL where the pipeline had no ok run in the window.',
              u.runs, u.ok_runs, p.max_gap, coalesce(o.max_ok_gap::text, 'none')) AS notes
FROM unwatched u
JOIN prof p ON p.pipeline = u.pipeline
LEFT JOIN okgaps o ON o.pipeline = u.pipeline
ON CONFLICT (pipeline) DO NOTHING;