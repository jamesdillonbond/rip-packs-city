-- audit_20261002: arm_unwatched_pipelines() — the 2026-09-04 "seed an info arm for every
-- unwatched pipeline" rule, made DAILY instead of one-off.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- 20260904044417 seeded cadence-watchlist arms for every pipeline that had none, derived
-- from each pipeline's own gap profile. It ran ONCE. By 2026-10-02 ~9:20 PM PT, 70 pipelines
-- that ran in the last 3 days had no watchlist row again, 24 of them meeting that rule's
-- own bar (12+ active days in 14, ran yesterday or today). The same evening the honesty
-- suite found seed-topshot-pack-distributions (pack-EV catalog) unwatched for its whole
-- life: a one-off sweep decays; a rule has to keep running.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────
-- The 09-04 rule VERBATIM (thresholds, exclusions, `info` severity, NULL no-success arm when
-- a pipeline had no ok run), wrapped in a function that also logs its own run, scheduled
-- daily. `info` never pages: it appears in the sentinel's WARN list and get_pipeline_alerts().
-- detect_stalled_pipelines() grants every new row a grace of its own threshold, so nothing
-- fires on insert. ON CONFLICT DO NOTHING: an existing row (including a deliberately
-- deactivated one, is_active=false) is NEVER touched — retiring a lane stays a human edit.
--
-- First run at apply: 24 arms (dry-run 2026-10-02 ~9:25 PM PT), incl. atlas-editions-refresh,
-- pack-nft-identity, allday-unmapped-atlas-resolver, the thp-leg-* health legs, sentinel.
--
-- Revert:
--   SELECT cron.unschedule('rpc-arm-unwatched-pipelines');
--   DROP FUNCTION public.arm_unwatched_pipelines();
--   DELETE FROM public.pipeline_cadence_watchlist WHERE notes LIKE 'Auto-armed % by arm_unwatched_pipelines()%';
CREATE OR REPLACE FUNCTION public.arm_unwatched_pipelines()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_armed   integer := 0;
  v_names   text[];
BEGIN
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
      -- (arm-unwatched-pipelines is NOT excluded: after 12 days it arms itself, so a run that
      --  throws, and therefore logs no row, ages into its own silence arm.)
  ),
  gaps AS (
    SELECT pipeline,
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
  ),
  ins AS (
    INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
    SELECT u.pipeline,
           greatest(60, 3 * p.max_gap),
           CASE WHEN o.max_ok_gap IS NULL THEN NULL
                ELSE greatest(2 * greatest(60, 3 * p.max_gap), 3 * o.max_ok_gap) END,
           'info',
           true,
           format('Auto-armed %s by arm_unwatched_pipelines() (the 2026-09-04 rule, daily since 2026-10-02): %s runs / %s ok in 14 d, max gap %s min, max ok-gap %s. info until a human read promotes it; no-success NULL where there was no ok run.',
                  current_date, u.runs, u.ok_runs, p.max_gap, coalesce(o.max_ok_gap::text, 'none'))
    FROM unwatched u
    JOIN prof p ON p.pipeline = u.pipeline
    LEFT JOIN okgaps o ON o.pipeline = u.pipeline
    ON CONFLICT (pipeline) DO NOTHING
    RETURNING pipeline
  )
  SELECT count(*)::int, array_agg(pipeline ORDER BY pipeline) INTO v_armed, v_names FROM ins;

  PERFORM public.log_pipeline_run(
    'arm-unwatched-pipelines', v_started, v_armed, v_armed, 0, true, NULL, NULL, NULL, NULL,
    jsonb_build_object('armed', coalesce(to_jsonb(v_names), '[]'::jsonb))
  );
  RETURN v_armed;
END;
$fn$;

REVOKE ALL ON FUNCTION public.arm_unwatched_pipelines() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arm_unwatched_pipelines() TO postgres, service_role;

SELECT public.arm_unwatched_pipelines();

-- 3:19 AM PT daily (10:19 UTC). Measured at apply: 0 hourly or hour-10 jobs on minute 19
-- (minute 41, the first pick, carries three hourly jobs).
SELECT cron.schedule('rpc-arm-unwatched-pipelines', '19 10 * * *', 'SELECT public.arm_unwatched_pipelines();');
