-- R124 / #126 follow-on — the failure-rate alarm arm splits at the instance restart.
--
-- CAUSE (measured 2026-09-20 4:40 PM PT): this arm pools a FIXED trailing window
-- (`day >= CURRENT_DATE - 2`, i.e. three calendar days). The instance restarted at
-- 10:39:56 AM PT on the Small -> Large resize, so the window STRADDLED a change point
-- and kept publishing the dead world: the five lanes #126 was filed about measured
-- 109/228 runs failed BEFORE the restart and 0/34 AFTER it, while the arm was still
-- calling `backfill-pack-rip-metadata` 61.0% high and `run-insider-detectors` 52.6% high.
-- A window that straddles a change point measures neither state, and this one would have
-- gone on doing it until ~09-22 10:40 AM PT.
--
-- FIX: the view gains a post-restart slice from `pipeline_runs` (run grain; the pooled
-- half stays on `pipeline_runs_daily`, day grain, which cannot be split mid-day). When the
-- restart falls INSIDE the window AND the post-restart slice has >= 10 runs, severity and
-- the headline come from that slice; below 10 runs nothing changes except a straddle
-- warning naming the restart. A row the split CLEARS is emitted at 'info' with both halves
-- spelled out — never dropped ("remove the failure mode; do not soften the detector").
-- The stale `last_error` is labelled PRE-RESTART when nothing has failed since.
--
-- ⚠ The 10-run floor is a JUDGEMENT, not a measurement: 0 failures in 10 runs against this
-- view's own 25% trigger is p = 0.75^10 = 5.6%, about the conventional threshold. Below it
-- the arm deliberately stays loud.
-- ⚠ `restart_in_window` can only be true for a restart inside `CURRENT_DATE - 2` (<= 72 h),
-- and `pipeline_runs` retains ~73 h, so the post slice is never truncated by retention. If
-- it ever were, the count would be LOWER and the arm would stay on the pooled rate — the
-- conservative direction.
-- 📝 Also corrects the detail's own wording: the window is three calendar days, not "2 days"
-- (established by 20260901183010, never reflected in the string).
--
-- REVERT:
--   CREATE OR REPLACE VIEW public.v_pipeline_failure_rates AS
--    SELECT pipeline,
--       sum(runs)::integer AS runs_2d,
--       sum(fail_count)::integer AS fails_2d,
--       round(100.0 * sum(fail_count)::numeric / NULLIF(sum(runs), 0)::numeric, 1) AS fail_pct,
--       max(last_error) AS last_error,
--       max(day) AS last_day
--      FROM pipeline_runs_daily d
--     WHERE day >= (CURRENT_DATE - 2)
--     GROUP BY pipeline
--    HAVING sum(runs) >= 5 AND (sum(fail_count)::numeric / NULLIF(sum(runs), 0)::numeric) > 0.25;
--   ALTER VIEW public.v_pipeline_failure_rates SET (security_invoker = on);
--   -- then re-splice the arm back to its pre-2026-09-20 form (the $old$ block below is it verbatim).
--
-- anon-exec: intentional — unchanged: the function is re-created from pg_get_functiondef(), preserving signature, SECURITY DEFINER and search_path, so ACLs are untouched and anon EXECUTE is and stays false (get_pipeline_alerts_core)

CREATE OR REPLACE VIEW public.v_pipeline_failure_rates AS
WITH restart AS (
  SELECT pg_postmaster_start_time() AS at,
         (CURRENT_DATE - 2)::timestamptz AS window_start
),
pooled AS (
  SELECT d.pipeline,
         sum(d.runs)::integer AS runs_2d,
         sum(d.fail_count)::integer AS fails_2d,
         round(100.0 * sum(d.fail_count)::numeric / NULLIF(sum(d.runs), 0)::numeric, 1) AS fail_pct,
         max(d.last_error) AS last_error,
         max(d.day) AS last_day
    FROM public.pipeline_runs_daily d
   WHERE d.day >= (CURRENT_DATE - 2)
   GROUP BY d.pipeline
  HAVING sum(d.runs) >= 5
     AND (sum(d.fail_count)::numeric / NULLIF(sum(d.runs), 0)::numeric) > 0.25
),
post AS (
  SELECT pr.pipeline,
         count(*)::integer AS runs_since_restart,
         count(*) FILTER (WHERE NOT pr.ok)::integer AS fails_since_restart
    FROM public.pipeline_runs pr, restart r
   WHERE r.at > r.window_start
     AND pr.started_at >= r.at
   GROUP BY pr.pipeline
)
SELECT p.pipeline,
       p.runs_2d,
       p.fails_2d,
       p.fail_pct,
       p.last_error,
       p.last_day,
       r.at AS instance_restart_at,
       (r.at > r.window_start) AS restart_in_window,
       COALESCE(po.runs_since_restart, 0) AS runs_since_restart,
       COALESCE(po.fails_since_restart, 0) AS fails_since_restart,
       CASE WHEN COALESCE(po.runs_since_restart, 0) > 0
            THEN round(100.0 * po.fails_since_restart::numeric / po.runs_since_restart::numeric, 1)
       END AS fail_pct_since_restart
  FROM pooled p
  CROSS JOIN restart r
  LEFT JOIN post po ON po.pipeline = p.pipeline;

ALTER VIEW public.v_pipeline_failure_rates SET (security_invoker = on);

DO $mig$
DECLARE
  def     text;
  old_arm text;
  new_arm text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p
   WHERE p.proname = 'get_pipeline_alerts_core'
     AND p.pronamespace = 'public'::regnamespace;

  IF def IS NULL THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core() not found — refusing to splice';
  END IF;

  old_arm := $old$      'severity', CASE WHEN f.fail_pct >= 50 THEN 'high' ELSE 'medium' END,
      'type',     'failure_rate',
      'pipeline', f.pipeline,
      'detail',   f.fails_2d || '/' || f.runs_2d || ' runs failed (' || f.fail_pct ||
                  '%) over the last 2 days. Last error: ' ||
                  COALESCE(left(f.last_error, 160), '(none recorded)')$old$;

  IF (length(def) - length(replace(def, old_arm, ''))) / length(old_arm) <> 1 THEN
    RAISE EXCEPTION 'failure_rate arm did not appear exactly once in get_pipeline_alerts_core() — refusing to splice';
  END IF;

  new_arm := $new$      'severity',
        CASE
          WHEN f.restart_in_window AND f.runs_since_restart >= 10 THEN
            CASE WHEN f.fail_pct_since_restart >= 50 THEN 'high'
                 WHEN f.fail_pct_since_restart > 25  THEN 'medium'
                 ELSE 'info' END
          WHEN f.fail_pct >= 50 THEN 'high'
          ELSE 'medium'
        END,
      'type',     'failure_rate',
      'pipeline', f.pipeline,
      'detail',
        CASE
          WHEN f.restart_in_window AND f.runs_since_restart >= 10 THEN
            f.fails_since_restart || '/' || f.runs_since_restart || ' runs failed (' ||
            f.fail_pct_since_restart || '%) SINCE THE INSTANCE RESTART at ' ||
            to_char(f.instance_restart_at AT TIME ZONE 'America/Los_Angeles', 'Mon DD HH24:MI') || ' PT' ||
            CASE WHEN f.fail_pct_since_restart <= 25
                 THEN ' — CLEARED BY THE SPLIT: reported for the record, not for triage. '
                 ELSE '. ' END ||
            'The pooled figure is ' || f.fails_2d || '/' || f.runs_2d || ' (' || f.fail_pct ||
            '%) over the last 3 calendar days and it STRADDLES that restart, so it describes a box that no longer exists.'
          WHEN f.restart_in_window THEN
            f.fails_2d || '/' || f.runs_2d || ' runs failed (' || f.fail_pct ||
            '%) over the last 3 calendar days. THAT WINDOW STRADDLES the instance restart at ' ||
            to_char(f.instance_restart_at AT TIME ZONE 'America/Los_Angeles', 'Mon DD HH24:MI') ||
            ' PT, and only ' || f.runs_since_restart || ' run(s) have landed since it (' ||
            f.fails_since_restart || ' failed) — too few to judge, so the pooled rate still sets severity. Split before re-triaging.'
          ELSE
            f.fails_2d || '/' || f.runs_2d || ' runs failed (' || f.fail_pct ||
            '%) over the last 3 calendar days.'
        END ||
        ' Last error' ||
        CASE WHEN f.restart_in_window AND f.runs_since_restart >= 10 AND f.fails_since_restart = 0
             THEN ' (PRE-RESTART — nothing has failed since)'
             ELSE '' END ||
        ': ' || COALESCE(left(f.last_error, 160), '(none recorded)')$new$;

  def := replace(def, old_arm, new_arm);
  EXECUTE def;
END
$mig$;
