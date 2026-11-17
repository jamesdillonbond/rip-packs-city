-- check_pipeline_cadence_collapse() — the arm this estate did not have.
--
-- WHY (measured 2026-09-11 PT). Nine lanes ran at 1/12th of their cadence for
-- TWO DAYS with every instrument green, including both user-facing alert lanes.
-- The reason is structural, not an oversight:
--   * the `cron_silent` arm and `detect_stalled_pipelines()` fire on TIME SINCE
--     THE LAST RUN against a 1,800-minute (30 h) threshold. A lane ticking every
--     177 minutes is never 30 h silent, so **to a silence detector a lane at
--     1/12th cadence is a healthy lane**;
--   * every one of those ticks wrote `ok = true`, because each tick genuinely
--     succeeded — `rows_written` and `ok` are silent about how MANY ticks ran;
--   * the GHA backstop that was carrying them is deliberately badge-less so it
--     cannot compete with the real alarm, so its firing is not a signal either.
-- Three green instruments, 1/12th of the work. The missing arm is a RATE arm.
--
-- WHAT IT COMPARES. Observed runs in a trailing window (from `pipeline_runs`,
-- ~73 h retention) against the lane's OWN trailing median runs/day (from
-- `pipeline_runs_daily`, indefinite). ⭐ No hand-maintained table of cadences:
-- each lane's normal is its own history, which is the shape CLAUDE.md prefers
-- (a tree walk over a curated list).
--
-- ⚠ THE BASELINE EXCLUDES THE RECENT DAYS ON PURPOSE (`p_exclude_days`). A
-- trailing window that includes the collapse decays toward it — "a trailing-window
-- rate LAGS a collapsed process, and the figure drifts in the REASSURING
-- direction" (database.md). With the defaults the baseline is days [-17, -3),
-- so the detector has a ~17-day memory: a collapse older than that becomes the
-- new normal and this arm goes quiet. That is a STATED limit, not a silent one —
-- `baseline_window` is published in the output so a reader can see it.
-- ⚠ It also sidesteps a second trap: `pipeline_runs_daily` is refreshed
-- six-hourly, so TODAY's row is partial and would understate every lane.
--
-- ⭐ IT SPLITS `degraded` FROM `stopped`, and that split is the whole point.
--   degraded = still ticking, but below the ratio. **Invisible to every existing
--              instrument** — this is the class that cost two days.
--   stopped  = zero runs in the window. Already `detect_stalled_pipelines()`'s
--              job once its 30 h elapses, so it is reported SEPARATELY rather
--              than duplicated into the same alarm.
-- A detector that merged them would fire on four long-retired lanes today and
-- read as noise, which is this estate's permanently-red-instrument trap (#25) —
-- so the split is what lets this be wired later without a suppression list.
--
-- THRESHOLDS ARE MEASURED, NOT GUESSED. Over all 100 lanes with a baseline of
-- >= 24 runs/day on 2026-09-11, the observed/baseline ratio over a 12-hour window
-- separates cleanly with nothing in between:
--   collapsed: 0.000 (x4, fully stopped) and 0.028-0.111 (x12, the nine
--              backstop-only lanes plus their two wmc-fmv RPC siblings and
--              offers-sweep)
--   healthy:   0.625 (pinnacle-resolve-buyers, the lowest) then 0.682, 0.696,
--              0.766 ... with the bulk at 0.92-1.05
-- p_ratio = 0.40 sits in that gap with a 1.56x margin to the lowest healthy lane
-- and a 3.6x margin to the highest collapsed one. ⚠ A 6-hour window was measured
-- too and rejected: it puts two healthy lanes at exactly 0.500 (32/day lanes
-- seeing 16), i.e. jitter on a half-hourly lane, which the 12-hour window removes.
--
-- ⚠ `%-heartbeat` partners mirror their lane exactly, so they would double every
-- offender. Excluded — and the exclusion is PUBLISHED (`excluded_heartbeats`),
-- because an exclusion nobody can count is how a guard goes quietly blind.
--
-- ⚠ NOT WIRED TO ANY ALARM IN THIS MIGRATION, deliberately. It would fire today
-- for the nine lanes whose cron-job.org entries are disabled (#76) and stay red
-- until an operator re-enables them; wiring it before that is the #25 trap.
-- Wire it after those entries are back, when a red means something new.
--
-- Cost, measured on an idle instance: 10,083 buffers / 1,406 ms at the defaults.
--
-- ⚠ The body below carries NO inline comments ON PURPOSE. Postgres stores them in
-- `prosrc`, so a comment present in the file and absent from production is DRIFT
-- that `npm run db:pins:check` reports and the repo-vs-repo drift guard cannot
-- see. Everything they said is in this header instead. Verified: the committed
-- body md5s identical to the deployed `prosrc` (whitespace-normalised).

CREATE OR REPLACE FUNCTION public.check_pipeline_cadence_collapse(
  p_baseline_days integer default 14,
  p_exclude_days  integer default 3,
  p_window_hours  integer default 12,
  p_ratio         numeric default 0.40,
  p_min_baseline  integer default 24
) returns jsonb
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
      count(*)                                              as observed_runs,
      max(r.started_at)                                     as last_run_at
    from public.pipeline_runs r
    where r.started_at > now() - make_interval(hours => greatest(p_window_hours, 1))
    group by r.pipeline
  ),
  scored as (
    select
      b.pipeline,
      b.baseline_per_day,
      b.baseline_days_seen,
      coalesce(o.observed_per_day, 0) as observed_per_day,
      coalesce(o.observed_runs, 0)    as observed_runs,
      o.last_run_at,
      case when b.baseline_per_day > 0
           then round(coalesce(o.observed_per_day, 0) / b.baseline_per_day, 3)
           else null end              as ratio
    from base b
    left join obs o on o.pipeline = b.pipeline
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
                             'min_baseline',  p_min_baseline),
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
               'ratio',            h.ratio,
               'last_run_at',      h.last_run_at
             ) order by h.ratio)
      from hits h where h.state = 'degraded'), '[]'::jsonb),
    'stopped',             coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',         h.pipeline,
               'baseline_per_day', h.baseline_per_day,
               'last_run_at',      h.last_run_at
             ) order by h.pipeline)
      from hits h where h.state = 'stopped'), '[]'::jsonb)
  );
$function$;

comment on function public.check_pipeline_cadence_collapse(integer, integer, integer, numeric, integer) is
  'Rate arm: observed runs in a trailing window vs each lane''s OWN trailing median runs/day. Exists because a silence detector cannot see a cadence collapse — the cron_silent arm fires at 1,800 minutes and a lane ticking every 177 minutes is never 30 h silent while every tick reads ok=true (nine lanes ran at 1/12th cadence for two days, #76). Splits `degraded` (still ticking, invisible to every existing instrument) from `stopped` (already detect_stalled_pipelines()''s job). Baseline EXCLUDES the recent days so a collapse cannot poison its own baseline, which also gives it a ~17-day memory at the defaults. NOT wired to any alarm while #76''s disabled cron-job.org entries stand.';

revoke all on function public.check_pipeline_cadence_collapse(integer, integer, integer, numeric, integer) from public, anon, authenticated;
grant execute on function public.check_pipeline_cadence_collapse(integer, integer, integer, numeric, integer) to service_role;
