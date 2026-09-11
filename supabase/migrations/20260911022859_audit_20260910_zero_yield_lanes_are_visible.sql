-- audit_20260910_zero_yield_lanes_are_visible
--
-- A FOURTH LANE STATE NOTHING ON THIS PLATFORM WATCHES (register #79).
-- The estate tracks three: didn't run (Pipeline Silence), ran and failed
-- (ok = false), ran and worked. A lane ticking every 15 minutes with ok = true
-- and rows_found = 0 forever is invisible to all three -- silence checks see it
-- ticking, failure checks see it green. That is how laliga_golazos listings went
-- 7+ days stale behind ~670 clean-reported runs (#78) with every instrument OK.
--
-- THE DESIGN PROBLEM AND ITS RESOLUTION. "Alarm on a sustained zero" is wrong:
-- a finished backfill, or a triage lane finding no errors, is a CORRECT zero.
-- Rather than hand-declare ~140 lanes, THE LANE'S OWN HISTORY IS THE DECLARATION
-- -- flag a lane that HAD a non-zero rows_found baseline and has since gone to
-- zero while still running. The curated part then shrinks to a SUPPRESSION list,
-- which is this repo's prescribed guard shape (ban at zero; suppression curated).
--
-- CALIBRATED BEFORE BUILT (2026-09-11 00:57Z): non-zero rows_found in days
-- -30..-8, exactly zero in the last 7, >= 50 runs in those 7 -> 5 lanes of 243.
-- Small enough to act on, non-zero so not vacuous, and it catches the known
-- defect (golazos-listings-indexer) without being told about it.
--
-- rows_found is NOT populated by every lane: allday-badge-low-ask-refresh and
-- golazos-badge-low-ask-refresh read found = 0 while writing 695,692 and 8,541
-- rows. They are excluded by the baseline requirement (no non-zero baseline to
-- fall from), which is why the rule keys on a FALL rather than on a level.

create table if not exists public.pipeline_zero_yield_suppressions (
  pipeline    text primary key,
  reason      text not null,
  added_at    timestamptz not null default now(),
  added_by    text
);

comment on table public.pipeline_zero_yield_suppressions is
  'Lanes whose sustained rows_found = 0 is EXPECTED (a finished backfill, a triage lane with nothing to find). The curated half of check_zero_yield_lanes(); everything not listed here alarms. A row is a CLAIM that zero is correct for that lane - state the evidence in reason.';

alter table public.pipeline_zero_yield_suppressions enable row level security;

revoke all on public.pipeline_zero_yield_suppressions from public, anon, authenticated;
grant select, insert, update, delete on public.pipeline_zero_yield_suppressions to postgres, service_role;

create or replace function public.check_zero_yield_lanes(
  p_baseline_days int default 30,
  p_zero_days     int default 7,
  p_min_runs      int default 50
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  with base as (
    select
      d.pipeline,
      sum(d.rows_found)  filter (where d.day <  current_date - p_zero_days) as found_baseline,
      sum(d.rows_found)  filter (where d.day >= current_date - p_zero_days) as found_recent,
      sum(d.rows_written) filter (where d.day >= current_date - p_zero_days) as written_recent,
      sum(d.runs)        filter (where d.day >= current_date - p_zero_days) as runs_recent,
      max(d.day)         filter (where d.rows_found > 0)                    as last_find
    from public.pipeline_runs_daily d
    where d.day >= current_date - p_baseline_days
    group by d.pipeline
  ),
  scored as (
    select b.*,
           (s.pipeline is not null) as suppressed,
           s.reason as suppress_reason
    from base b
    left join public.pipeline_zero_yield_suppressions s on s.pipeline = b.pipeline
  ),
  hits as (
    select * from scored
    where coalesce(found_baseline, 0) > 0
      and coalesce(found_recent, 0) = 0
      and coalesce(runs_recent, 0) >= p_min_runs
  )
  select jsonb_build_object(
    'inspected',  (select count(*) from base),
    'window',     jsonb_build_object('baseline_days', p_baseline_days,
                                     'zero_days', p_zero_days,
                                     'min_runs', p_min_runs),
    'suppressed', (select count(*) from hits where suppressed),
    'offenders',  coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',       h.pipeline,
               'found_baseline', h.found_baseline,
               'runs_recent',    h.runs_recent,
               'written_recent', h.written_recent,
               'last_find',      h.last_find
             ) order by h.runs_recent desc)
      from hits h where not h.suppressed), '[]'::jsonb)
  );
$$;

comment on function public.check_zero_yield_lanes(int, int, int) is
  'Lanes that HAD a rows_found baseline and have since gone to exactly zero while still running - the "ran, succeeded, found nothing" state no silence- or failure-based check can see (register #79). Returns inspected / suppressed / offenders; suppression lives in pipeline_zero_yield_suppressions.';

revoke execute on function public.check_zero_yield_lanes(int, int, int) from public, anon, authenticated;
grant execute on function public.check_zero_yield_lanes(int, int, int) to postgres, service_role;
