-- audit_20260918_cadence_collapse_publishes_the_true_last_run
--
-- Deep-audit R102 (2026-09-18, P2) — a safety instrument publishing an `unknown`
-- that is actually KNOWN.
--
-- WHAT WAS WRONG. `check_pipeline_cadence_collapse()` published `last_run_at`
-- out of its OBSERVATION-WINDOW CTE (`obs`, the trailing `p_window_hours`). A lane
-- with zero runs in that window fell through the LEFT JOIN and the payload read
-- `"last_run_at": null` — for eight lanes at once on 2026-09-18, every one of whose
-- last run was plainly readable in `pipeline_runs` (`wallet-backfill` last ran
-- 00:51 PT, well inside the ~73 h retention). ⭐ The FIELD NAME asks "when did this
-- lane last run"; the value answered "when did it last run inside the window", and
-- those differ exactly when the arm fires. It is the #80 mirror defect living
-- inside a safety instrument, and it is not academic: a pass read those nulls as
-- "these lanes never resumed after the outage" and nearly filed a false P0. The raw
-- `extra` payload is what stopped it — `{"reason":"12h_cadence_gate"}` — i.e. the
-- lanes had deliberately DECLINED to dispatch inside a designed 12 h gate.
--
-- WHAT CHANGES. A new `last_seen` CTE computes `max(started_at)` per lane over the
-- readable history (72 h, matching retention, so this is NOT an unbounded scan of a
-- partitioned table on an IO-constrained instance), and that is what the payload
-- publishes. Two additive fields state the thing the null used to hide:
-- `hours_since_last_run`, and on a `stopped` row `ran_within_retention`, which is
-- the discriminator between "this lane is paused" and "this lane has no readable
-- history at all". `observed_runs` is now published on `degraded` rows too, so the
-- ratio can be checked against its numerator.
--
-- ⛔ WHAT DELIBERATELY DOES NOT CHANGE, and why. R102 also proposed EXEMPTING
-- `12h_cadence_gate` lanes from `stopped`. Not done: an exemption keyed on a lane's
-- own self-reported reason is a suppression that would hide a genuine stall on the
-- same lanes, and the honest `last_run_at` already removes the misreading that
-- motivated it. The `degraded`/`stopped` split, the baseline exclusion, the
-- heartbeat exclusion and the `p_min_baseline` floor are all untouched — those are
-- the properties `supabase/tests/check_pipeline_cadence_collapse.sql` pins, and the
-- verbatim copy there is updated in the same commit.
--
-- SIGNATURE UNCHANGED (5 params), so the existing grants survive CREATE OR REPLACE;
-- they are restated below for idempotence.
--
-- REVERT: re-apply the function body from
-- supabase/migrations/20260912054710_audit_20260911_a_silence_detector_cannot_see_a_cadence_collapse.sql
-- and repoint the `check_pipeline_cadence_collapse` entry in
-- __tests__/db-invariants-drift-guard.test.ts back at that file. No data is touched.

CREATE OR REPLACE FUNCTION public.check_pipeline_cadence_collapse(
  p_baseline_days integer DEFAULT 14,
  p_exclude_days  integer DEFAULT 3,
  p_window_hours  integer DEFAULT 12,
  p_ratio         numeric DEFAULT 0.40,
  p_min_baseline  integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  with base as (
    select
      d.pipeline,
      percentile_cont(0.5) within group (order by d.runs)::numeric as baseline_per_day,
      count(*)                                                     as baseline_days_seen
    from public.pipeline_runs_daily d
    where d.day >= current_date - (p_baseline_days + p_exclude_days)
      and d.day <  current_date - p_exclude_days
      and d.pipeline not like '%-heartbeat'
    group by d.pipeline
  ),
  obs as (
    select
      r.pipeline,
      count(*)::numeric * 24.0 / greatest(p_window_hours, 1) as observed_per_day,
      count(*)                                              as observed_runs
    from public.pipeline_runs r
    where r.started_at > now() - make_interval(hours => greatest(p_window_hours, 1))
    group by r.pipeline
  ),
  last_seen as (
    -- R102 (2026-09-18). The published `last_run_at` used to come from `obs`, i.e.
    -- from the OBSERVATION WINDOW, so a lane with zero runs in the last 12 h got a
    -- NULL through the left join and the payload said `"last_run_at": null` for
    -- eight lanes whose last run was plainly readable in pipeline_runs. The field
    -- NAME claims "when did this lane last run"; the value answered a different
    -- question, inside a SAFETY instrument. That is the #80 mirror defect -- an
    -- `unknown` that is actually KNOWN -- and it cost a pass a false "these lanes
    -- never resumed after the outage" reading.
    --
    -- Bounded at 72 h deliberately: pipeline_runs retains ~73 h, so this is the
    -- whole readable history and NOT an unbounded scan of a partitioned table on an
    -- IO-constrained instance. A lane silent longer than that publishes null, which
    -- is then the true answer for this instrument rather than an artifact.
    select r.pipeline, max(r.started_at) as last_run_at
    from public.pipeline_runs r
    where r.started_at > now() - interval '72 hours'
    group by r.pipeline
  ),
  scored as (
    select
      b.pipeline,
      b.baseline_per_day,
      b.baseline_days_seen,
      coalesce(o.observed_per_day, 0) as observed_per_day,
      coalesce(o.observed_runs, 0)    as observed_runs,
      l.last_run_at,
      case when b.baseline_per_day > 0
           then round(coalesce(o.observed_per_day, 0) / b.baseline_per_day, 3)
           else null end              as ratio
    from base b
    left join obs o       on o.pipeline = b.pipeline
    left join last_seen l on l.pipeline = b.pipeline
    where b.baseline_per_day >= p_min_baseline
  ),
  hits as (
    select *,
           case when observed_runs = 0 then 'stopped' else 'degraded' end as state
    from scored
    where observed_per_day < p_ratio * baseline_per_day
  )
  select jsonb_build_object(
    'inspected',           (select count(*) from scored),
    'window',              jsonb_build_object(
                             'baseline_days', p_baseline_days,
                             'exclude_days',  p_exclude_days,
                             'window_hours',  p_window_hours,
                             'ratio',         p_ratio,
                             'min_baseline',  p_min_baseline,
                             'last_run_lookback_hours', 72),
    'baseline_window',     jsonb_build_object(
                             'from', (current_date - (p_baseline_days + p_exclude_days))::text,
                             'to',   (current_date - p_exclude_days)::text),
    'excluded_heartbeats', (select count(distinct d.pipeline) from public.pipeline_runs_daily d
                             where d.day >= current_date - (p_baseline_days + p_exclude_days)
                               and d.day <  current_date - p_exclude_days
                               and d.pipeline like '%-heartbeat'),
    'degraded_count',      (select count(*) from hits where state = 'degraded'),
    'stopped_count',       (select count(*) from hits where state = 'stopped'),
    'degraded',            coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',         h.pipeline,
               'baseline_per_day', h.baseline_per_day,
               'observed_per_day', h.observed_per_day,
               'observed_runs',    h.observed_runs,
               'ratio',            h.ratio,
               'last_run_at',      h.last_run_at,
               'hours_since_last_run',
                 case when h.last_run_at is null then null
                      else round(extract(epoch from (now() - h.last_run_at))::numeric / 3600.0, 2) end
             ) order by h.ratio)
      from hits h where h.state = 'degraded'), '[]'::jsonb),
    'stopped',             coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',         h.pipeline,
               'baseline_per_day', h.baseline_per_day,
               'last_run_at',      h.last_run_at,
               'hours_since_last_run',
                 case when h.last_run_at is null then null
                      else round(extract(epoch from (now() - h.last_run_at))::numeric / 3600.0, 2) end,
               'ran_within_retention', (h.last_run_at is not null)
             ) order by h.pipeline)
      from hits h where h.state = 'stopped'), '[]'::jsonb)
  );
$function$;

comment on function public.check_pipeline_cadence_collapse(integer, integer, integer, numeric, integer) is
  'Rate arm: observed runs in a trailing window vs each lane''s OWN trailing median runs/day. Exists because a silence detector cannot see a cadence collapse — the cron_silent arm fires at 1,800 minutes and a lane ticking every 177 minutes is never 30 h silent while every tick reads ok=true (nine lanes ran at 1/12th cadence for two days, #76). Splits `degraded` (still ticking, invisible to every existing instrument) from `stopped` (already detect_stalled_pipelines()''s job). Baseline EXCLUDES the recent days so a collapse cannot poison its own baseline, which also gives it a ~17-day memory at the defaults. 2026-09-18 (R102): `last_run_at` is now the lane''s TRUE last run over the 72 h readable history, not its last run inside the observation window — the old spelling published null for lanes whose last run was readable, inside a safety instrument. NOT wired to any alarm while #76''s disabled cron-job.org entries stand.';

revoke all on function public.check_pipeline_cadence_collapse(integer, integer, integer, numeric, integer) from public, anon, authenticated;
grant execute on function public.check_pipeline_cadence_collapse(integer, integer, integer, numeric, integer) to service_role;
