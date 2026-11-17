-- audit_20260909_pgcron_failure_rate_fence_is_falsifiable
--
-- WHY: the pk_fence migration (20260909234348) added a `complete` flag that is
-- false when the runid fence cuts the window short, so a bound fence reports a
-- LOWER BOUND instead of publishing an under-count as a measurement. Good shape,
-- but I then tried to write a control proving the flag can go false and COULD
-- NOT: the fence is sized 3,000 runs/hour and the estate runs ~362/hour, and the
-- span SCALES with p_window, so widening the window widens the fence too. There
-- is no p_window that binds it, and cron.job_run_details is owned by
-- supabase_admin so no synthetic row can be inserted to force one.
--
-- ⛔ That left `complete` UNFALSIFIABLE IN PRODUCTION: a flag no test can drive
-- to its interesting value is indistinguishable from a flag hard-wired true.
-- CLAUDE.md's own rule -- "prove a watcher can see a FAILURE before relying on
-- it" -- and the permanently-green-instrument trap. The honesty branch it feeds
-- was dead code.
--
-- FIX: an OPTIONAL fence-span override. p_fence_span null (every production
-- caller, including the sentinel's PostgREST rpc which passes only p_window)
-- keeps the computed span exactly as before; a caller may pass a small span to
-- drive the fence into binding and observe `complete` = false through the REAL
-- code path, not a copy of it. Read-only knob: it can only NARROW what is read,
-- so a hostile value under-reports and is reported as under-reporting, which is
-- the branch being exercised.
--
-- ⭐ PROVEN LIVE the moment it applied, both directions and with a no-change
-- control: span 100 -> complete false, runs 100; span 50000 (the computed floor)
-- -> complete true, runs 2174; default (no override) -> complete true, runs
-- 2174, identical to the pre-change answer. The override path and the computed
-- path agree at the same span, so the knob does not shift semantics.
--
-- Signature CHANGES (adds a defaulted 2nd arg), so per the migration checklist:
-- the 1-arg overload is DROPPED in this same transaction (leaving both makes a
-- 1-arg call ambiguous), and EXECUTE is re-REVOKEd from PUBLIC, anon,
-- authenticated in ONE statement then GRANTed to postgres, service_role -- a new
-- overload lands with default PUBLIC EXECUTE and silently re-grants what the
-- original REVOKE removed. Verified after with has_function_privilege (anon
-- false, authenticated false, service_role true, postgres true), exactly 1
-- overload remaining, and check_secdef_anon_exec_drift() array length 0.
--
-- REVERT: re-apply migration 20260909234348's body (1-arg), drop the 2-arg
-- overload, and re-apply 20260909234551's COMMENT.

drop function if exists public.check_pgcron_failure_rate(interval);

create or replace function public.check_pgcron_failure_rate(
  p_window interval default '6 hours'::interval,
  p_fence_span bigint default null
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  with bounds as (
    select
      (select max(d.runid) from cron.job_run_details d) as max_runid,
      -- p_fence_span is a TEST/DIAGNOSTIC override only. Null (all production
      -- callers) computes the shipped span: 3,000 runs per hour of window, floor
      -- 50,000, against a measured ~362/hour.
      coalesce(
        nullif(p_fence_span, 0),
        greatest(
          50000::bigint,
          (ceil(extract(epoch from p_window) / 3600.0) * 3000)::bigint
        )
      ) as fence_span
  ),
  fenced as (
    select d.runid, d.jobid, d.status, d.return_message, d.start_time
    from cron.job_run_details d, bounds b
    where d.runid > b.max_runid - b.fence_span
  ),
  -- Does the fenced set reach back past the window start? If not, the fence
  -- bound and every count below is a LOWER BOUND, not a measurement.
  coverage as (
    select (min(start_time) <= now() - p_window) as complete
    from fenced
  ),
  runs as (
    select jobid, status, return_message
    from fenced
    where start_time > now() - p_window
      and status in ('failed', 'succeeded')
  ),
  agg as (
    select
      count(*)                                                          as runs,
      count(*) filter (where status = 'failed')                         as fails,
      count(distinct jobid) filter (where status = 'failed')             as jobs_failing,
      count(*) filter (where status = 'failed'
                         and return_message ilike '%startup timeout%')   as startup_timeouts,
      count(*) filter (where status = 'failed'
                         and (return_message ilike '%statement timeout%'
                           or return_message ilike '%canceling statement%')) as statement_timeouts,
      -- NOT clause rather than subtraction: exact, and cannot go negative if a
      -- message ever matches both patterns.
      count(*) filter (where status = 'failed'
                         and coalesce(return_message, '') not ilike '%startup timeout%'
                         and coalesce(return_message, '') not ilike '%statement timeout%'
                         and coalesce(return_message, '') not ilike '%canceling statement%') as other_fails
    from runs
  ),
  top as (
    select j.jobname, count(*) as fails
    from runs r
    join cron.job j on j.jobid = r.jobid
    where r.status = 'failed'
    group by j.jobname
    order by count(*) desc, j.jobname
    limit 5
  )
  select jsonb_build_object(
    'window_text',        p_window::text,
    'runs',               a.runs,
    'fails',              a.fails,
    'jobs_failing',       a.jobs_failing,
    'startup_timeouts',   a.startup_timeouts,
    'statement_timeouts', a.statement_timeouts,
    'other_fails',        a.other_fails,
    'complete',           coalesce(c.complete, false),
    'top', coalesce(
      (select jsonb_agg(jsonb_build_object('jobname', t.jobname, 'fails', t.fails)) from top t),
      '[]'::jsonb)
  )
  from agg a, coverage c
$fn$;

revoke execute on function public.check_pgcron_failure_rate(interval, bigint) from public, anon, authenticated;
grant execute on function public.check_pgcron_failure_rate(interval, bigint) to postgres, service_role;

comment on function public.check_pgcron_failure_rate(interval, bigint) is
  'Fleet-level pg_cron failure RATE over p_window (default 6h), as one jsonb row: runs, fails, jobs_failing, startup_timeouts, statement_timeouts, other_fails, complete, top 5 offenders. Added 2026-09-09 after a spell logged 399 failures with nothing watching: the sentinel reads only pipeline_runs, and a job that fails to START writes no pipeline_runs row. Complements check_pgcron_recent_failures(), which filters to jobs whose LATEST run failed and therefore misses a high-rate intermittent failer (measured: 23-fail and 19-fail jobs invisible at every probe on 2026-09-09). PERFORMANCE: cron.job_run_details has no index on start_time and is owned by supabase_admin (postgres cannot add one - known-issues #60), so the scan is fenced on the runid PK, sized at 3,000/h with a 50,000 floor against a measured ~362/h; 18,313 physical buffer reads -> 628, same answers. `complete` is false when that fence bound the window, in which case every count is a LOWER BOUND -- p_fence_span is a TEST-ONLY override (null in every production caller) that exists so `complete` can be driven false through the real code path; without it the flag was unfalsifiable, because the fence scales with p_window and no window binds it. THRESHOLD BASELINE, re-measured over 30 days and NOT the 7-day figure first recorded here: 2026-08-11..08-30 ran at 50-496 failures/DAY (startup timeouts 36-332/day), 08-31..09-08 at 0-3/day, 09-09 at 399. The drop coincides with the 08-31 top-consumer IO drain (dated correlation, plausible mechanism, not proven - several things shipped that day; and that drain never claimed this benefit). Thresholds are calibrated to the POST-08-31 regime on purpose: the estate demonstrably runs at 0-3/day, and this arm would have been loud for the three weeks before it, which is the period nobody watched this surface.';
