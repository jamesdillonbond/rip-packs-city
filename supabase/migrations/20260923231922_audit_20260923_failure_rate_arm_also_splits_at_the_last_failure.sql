-- R124 follow-on — the failure-rate alarm also splits at the LAST FAILURE, not only at an instance restart.
--
-- CAUSE (measured 2026-09-23 ~4:20 PM PT): R124 (20260921004921) taught this arm to split its
-- three-calendar-day window at `pg_postmaster_start_time()`, and wrote down what that does NOT
-- cover: "a deploy, a migration, an index build or an upstream change is just as much a change
-- point and this arm is still blind to all of them." The live instance of that gap:
-- `compute-allday-pack-ev` was fixed on 2026-09-22 ~11 AM PT (the `pool prune 5349: Bad Request`
-- defect), has run 58/58 ok since, and the arm STILL pages it `high` — "75/133 runs failed (56.4%)"
-- — and would until ~09-24 5 PM PT, when the failing days leave `CURRENT_DATE - 2`. Every pass in
-- between re-diagnoses it as "R124 pooling — benign". A fix to ANY lane buys ~3 days of a false
-- HIGH; that is the failure mode, so it is removed here rather than learned around.
--
-- FIX: the view gains a run-grain slice anchored at the lane's LAST FAILURE inside the window
-- (`pipeline_runs`, which retains ~73 h >= the window). A lane is `cleared_by_streak` when:
--   * its last failure is visible in run grain (NULL -> stays loud),
--   * >= 20 runs have landed since it, ALL ok (a NULL-ok run blocks the clear),
--   * and that last failure is >= 12 h old (a fast lane cannot clear on a 10-minute burst).
-- A cleared row is emitted at 'info' with both halves spelled out — never dropped ("remove the
-- failure mode; do not soften the detector") — and the very next failure re-arms it at full
-- severity, because the anchor moves to that failure and the streak restarts at 0.
-- The restart split keeps precedence when it applies.
--
-- ⚠ THE 20-RUN FLOOR IS A JUDGEMENT, and it is deliberately STRICTER than the restart split's 10:
-- the restart is an EXTERNAL change point, whereas "the last failure" is chosen FROM THE DATA,
-- which biases toward clearing (every intermittent lane has a current streak). 20 straight ok
-- runs against this view's own 25% trigger is p = 0.75^20 = 0.3%; the 12 h floor keeps a lane
-- that fails in bursts from clearing between them. A daily lane can never reach 20 in the window,
-- so it stays loud — the conservative direction.
--
-- 📝 ALSO FIXES `last_error`: the pooled half is `max(d.last_error)` over `pipeline_runs_daily`,
-- which is LEXICOGRAPHIC, not newest (CLAUDE.md: "max() on a text cursor is lexicographic"). The
-- view now carries `latest_error` (newest failing run's `error` in the window, run grain) and the
-- arm prefers it, falling back to the pooled value only when run grain has none.
--
-- Columns are APPENDED only (CREATE OR REPLACE VIEW cannot reorder — 42P16), and the only reader
-- in the database is get_pipeline_alerts_core() (pg_depend + prosrc scan, 2026-09-23).
--
-- REVERT: re-apply the view body from 20260921004921 (CREATE OR REPLACE cannot DROP the appended
-- columns, so `DROP VIEW public.v_pipeline_failure_rates` first, then re-create it from that file
-- in the same transaction together with the arm below), then re-splice the arm: swap the $new$
-- block below back for the $old$ block (it is the 20260921004921 arm verbatim).
--
-- anon-exec: unchanged (get_pipeline_alerts_core) — re-created from pg_get_functiondef(), so signature, SECURITY DEFINER, search_path and ACL are preserved; verified has_function_privilege anon=false, authenticated=false on 2026-09-23.

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
),
streak AS (
  SELECT p.pipeline,
         lf.last_fail_at,
         le.latest_error,
         CASE WHEN lf.last_fail_at IS NOT NULL THEN
           (SELECT count(*)::integer FROM public.pipeline_runs pr
             WHERE pr.pipeline = p.pipeline AND pr.started_at > lf.last_fail_at AND pr.ok)
         END AS ok_runs_since_last_fail,
         CASE WHEN lf.last_fail_at IS NOT NULL THEN
           (SELECT count(*)::integer FROM public.pipeline_runs pr
             WHERE pr.pipeline = p.pipeline AND pr.started_at > lf.last_fail_at AND pr.ok IS NOT TRUE)
         END AS notok_runs_since_last_fail
    FROM pooled p
    CROSS JOIN restart r
    CROSS JOIN LATERAL (
      SELECT max(pr.started_at) FILTER (WHERE NOT pr.ok) AS last_fail_at
        FROM public.pipeline_runs pr
       WHERE pr.pipeline = p.pipeline AND pr.started_at >= r.window_start
    ) lf
    LEFT JOIN LATERAL (
      SELECT pr.error AS latest_error
        FROM public.pipeline_runs pr
       WHERE pr.pipeline = p.pipeline AND pr.started_at >= r.window_start AND NOT pr.ok
       ORDER BY pr.started_at DESC
       LIMIT 1
    ) le ON true
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
       END AS fail_pct_since_restart,
       s.last_fail_at,
       s.ok_runs_since_last_fail,
       s.notok_runs_since_last_fail,
       s.latest_error,
       COALESCE(
         s.last_fail_at IS NOT NULL
         AND s.last_fail_at <= now() - interval '12 hours'
         AND s.ok_runs_since_last_fail >= 20
         AND s.notok_runs_since_last_fail = 0,
         false) AS cleared_by_streak
  FROM pooled p
  CROSS JOIN restart r
  LEFT JOIN post po ON po.pipeline = p.pipeline
  LEFT JOIN streak s ON s.pipeline = p.pipeline;

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

  old_arm := $old$      'severity',
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
        ': ' || COALESCE(left(f.last_error, 160), '(none recorded)')$old$;

  IF (length(def) - length(replace(def, old_arm, ''))) / length(old_arm) <> 1 THEN
    RAISE EXCEPTION 'R124 failure_rate arm did not appear exactly once in get_pipeline_alerts_core() — refusing to splice';
  END IF;

  new_arm := $new$      'severity',
        CASE
          WHEN f.restart_in_window AND f.runs_since_restart >= 10 THEN
            CASE WHEN f.fail_pct_since_restart >= 50 THEN 'high'
                 WHEN f.fail_pct_since_restart > 25  THEN 'medium'
                 ELSE 'info' END
          WHEN f.cleared_by_streak THEN 'info'
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
          WHEN f.cleared_by_streak THEN
            '0/' || f.ok_runs_since_last_fail || ' runs failed since the last failure at ' ||
            to_char(f.last_fail_at AT TIME ZONE 'America/Los_Angeles', 'Mon DD HH24:MI') || ' PT (' ||
            round(extract(epoch FROM (now() - f.last_fail_at)) / 3600.0)::int ||
            ' h ago) — CLEARED BY THE STREAK SPLIT: reported for the record, not for triage. ' ||
            'The pooled figure is ' || f.fails_2d || '/' || f.runs_2d || ' (' || f.fail_pct ||
            '%) over the last 3 calendar days and it STRADDLES a change point (a deploy, migration or upstream recovery — this arm cannot see which), so it describes a lane that has since recovered. A new failure re-arms this row at full severity.'
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
             WHEN f.cleared_by_streak
             THEN ' (BEFORE THE STREAK — nothing has failed since)'
             ELSE '' END ||
        ': ' || COALESCE(left(COALESCE(f.latest_error, f.last_error), 160), '(none recorded)')$new$;

  def := replace(def, old_arm, new_arm);
  EXECUTE def;
END
$mig$;
