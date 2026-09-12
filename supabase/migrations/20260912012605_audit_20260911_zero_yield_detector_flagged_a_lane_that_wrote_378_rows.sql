-- audit_20260911_zero_yield_detector_flagged_a_lane_that_wrote_378_rows
--
-- FALSE POSITIVE IN A GUARD I SHIPPED YESTERDAY. check_zero_yield_lanes() flagged
-- `drain-conflated-subeditions` as zero-yield while it was writing real rows:
-- measured 2026-09-11 18:2x PT over 7 days, rows_found = 0 but rows_written = 378,
-- and its own `extra` says `split.sales_split = 378`, `split.moments_split = 821`.
-- The lane is working; the detector was reading the wrong column.
--
-- ⭐ ROOT CAUSE IS THIS ESTATE'S OWN #70 TRAP: `rows_found` and `rows_written` do
-- NOT mean the same thing lane to lane. Some lanes never populate `rows_found` at
-- all. The detector keyed on `found_recent = 0` and REPORTED `written_recent`
-- without EXCLUDING on it, so a lane that writes hundreds of rows while leaving
-- rows_found at 0 reads as dead.
--
-- THE FIX, and why this direction and not the other: `written_recent > 0` is
-- POSITIVE evidence of yield and is safe to exclude on. `written_recent = 0` is
-- ambiguous (a null instrument, same as rows_found), so it is NOT used as evidence
-- of death — the found-based predicate still carries that half. The asymmetry is
-- the whole point.
--
-- ⚠ AND THE EXCLUSION IS PUBLISHED, NOT SILENT. A new `excluded_by_writes` count
-- reports how many lanes this clause removed. An exclusion nobody can see is how a
-- guard goes quietly blind, and this file's own subject is a guard that went wrong
-- in a way nobody could see. If that number climbs, the detector is hiding lanes.
--
-- SATISFIABLE AT ZERO: it is a filter, not a requirement — with no offenders the
-- function still returns `offenders: []` and does not punish its own success.
--
-- anon-exec: same signature, so this CREATE OR REPLACE PRESERVES the ACL set by
-- 20260911022859 (no new overload is created and no default PUBLIC EXECUTE is
-- granted). The revoke/grant below are re-asserted idempotently rather than
-- assumed, and verified after with has_function_privilege rather than acl text --
-- check_zero_yield_lanes is a service-role/sentinel instrument and must not be
-- anon-callable.
--
-- REVERT: re-apply the function body from
-- 20260911022859_audit_20260910_zero_yield_lanes_are_visible.sql (drop the
-- written_recent clause and the excluded_by_writes key). No table or data change.

create or replace function public.check_zero_yield_lanes(
  p_baseline_days int default 30,
  p_zero_days     int default 7,
  p_min_runs      int default 50
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $fn$
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
  -- Candidates on the FOUND-based predicate alone: what the detector saw before
  -- this migration. Kept as its own CTE so the write-based exclusion can be
  -- counted rather than merely applied.
  candidates as (
    select * from scored
    where coalesce(found_baseline, 0) > 0
      and coalesce(found_recent, 0) = 0
      and coalesce(runs_recent, 0) >= p_min_runs
  ),
  hits as (
    -- ⭐ A lane that WROTE rows in the window has yield by definition, whatever it
    -- reports in rows_found. Excluding on written_recent > 0 only; a zero here is
    -- NOT treated as evidence of death.
    select * from candidates
    where coalesce(written_recent, 0) = 0
  )
  select jsonb_build_object(
    'inspected',  (select count(*) from base),
    'window',     jsonb_build_object('baseline_days', p_baseline_days,
                                     'zero_days', p_zero_days,
                                     'min_runs', p_min_runs),
    'suppressed', (select count(*) from hits where suppressed),
    -- Publish what the new clause removed, so the exclusion stays measurable.
    'excluded_by_writes', (select count(*) from candidates where coalesce(written_recent, 0) > 0),
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
$fn$;

revoke execute on function public.check_zero_yield_lanes(int, int, int) from public, anon, authenticated;
grant execute on function public.check_zero_yield_lanes(int, int, int) to postgres, service_role;