-- NEW HEALTH METRIC: pipeline FAILURE RATE.
--
-- The structural gap this closes: every one of the 98 `pipeline_cadence_watchlist`
-- rows keys on `max_silent_minutes` only, so the entire alerting model asks
-- "did it RUN?" and never "did it WORK?". Measured 2026-08-01, three pipelines
-- were failing hard while every sentinel read green:
--   topshot-active-listings-ingest        51.6% fail  (watchlist verdict: ok)
--   topshot-pack-opens-history-backfill   71.9% fail  (watchlist verdict: ok)
--   topshot-misattrib-drain              100.0% fail  (not watchlisted at all)
-- Reads the indefinite `pipeline_runs_daily` rollup, so it survives the ~73h
-- `pipeline_runs` retention window that hides most of these.
CREATE OR REPLACE VIEW public.v_pipeline_failure_rates AS
SELECT
  d.pipeline,
  sum(d.runs)::int                                   AS runs_2d,
  sum(d.fail_count)::int                             AS fails_2d,
  round(100.0 * sum(d.fail_count) / NULLIF(sum(d.runs), 0), 1) AS fail_pct,
  max(d.last_error)                                  AS last_error,
  max(d.day)                                         AS last_day
FROM public.pipeline_runs_daily d
WHERE d.day >= current_date - 2
GROUP BY d.pipeline
HAVING sum(d.runs) >= 5
   AND sum(d.fail_count)::numeric / NULLIF(sum(d.runs), 0) > 0.25;

ALTER VIEW public.v_pipeline_failure_rates SET (security_invoker = on);
REVOKE SELECT ON public.v_pipeline_failure_rates FROM anon, authenticated;

-- Wire it into the paging path as a new UNION ALL arm. Guarded splice off
-- pg_get_functiondef: aborts if the anchor drifts rather than silently no-op'ing,
-- so the existing arms stay byte-identical. Honours pipeline_alert_suppression
-- exactly like every other arm.
DO $mig$
DECLARE
  src text; out_src text;
  anchor CONSTANT text := E'  )\n  SELECT COALESCE(jsonb_agg(a ORDER BY';
  arm CONSTANT text :=
E'\n    UNION ALL\n\n    -- FAILURE-RATE arm (added 2026-08-01): a pipeline can fire on schedule and\n    -- fail every single time. Cadence checks read that as healthy; this does not.\n    SELECT jsonb_build_object(\n      ''severity'', CASE WHEN f.fail_pct >= 50 THEN ''high'' ELSE ''medium'' END,\n      ''type'',     ''failure_rate'',\n      ''pipeline'', f.pipeline,\n      ''detail'',   f.fails_2d || ''/'' || f.runs_2d || '' runs failed ('' || f.fail_pct ||\n                  ''%) over the last 2 days. Last error: '' ||\n                  COALESCE(left(f.last_error, 160), ''(none recorded)'')\n    )\n    FROM public.v_pipeline_failure_rates f\n    WHERE f.pipeline NOT IN (SELECT pipeline FROM active_suppressions)\n';
BEGIN
  SELECT pg_get_functiondef(oid) INTO src FROM pg_proc WHERE proname = 'get_pipeline_alerts';
  IF src IS NULL THEN RAISE EXCEPTION 'get_pipeline_alerts not found'; END IF;
  IF position(anchor in src) = 0 THEN
    RAISE EXCEPTION 'get_pipeline_alerts tail anchor not found — aborting, nothing changed';
  END IF;
  IF position('''failure_rate''' in src) > 0 THEN
    RAISE NOTICE 'failure_rate arm already present — skipping';
    RETURN;
  END IF;
  out_src := replace(src, anchor, arm || anchor);
  EXECUTE out_src;
END
$mig$;