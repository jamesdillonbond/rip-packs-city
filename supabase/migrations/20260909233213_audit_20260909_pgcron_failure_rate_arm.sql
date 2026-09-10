-- audit_20260909_pgcron_failure_rate_arm
--
-- WHY: on 2026-09-09 the instance logged 399 pg_cron failures (262 cancelled at
-- a statement budget, 135 `job startup timeout` against max_worker_processes = 6)
-- against a 7-day fleet baseline of 0-3 per DAY. Nothing saw the number.
-- Verified: app/api/sentinel/route.ts contained ZERO references to
-- cron.job_run_details -- every sentinel arm reads pipeline_runs, and a job that
-- fails to START never writes a pipeline_runs row (log_pipeline_run is inside the
-- body, which never runs).
--
-- The one existing instrument, check_pgcron_recent_failures(), had NO CALLER
-- anywhere in the repo (it appears only inside other migrations' comments), and
-- its `where l.status = 'failed'` filter answers "which jobs are broken right
-- now", not "which jobs are failing a lot". Measured at four probe times that
-- day: rpc-ts-listings-atlas-sync WOULD have surfaced (latest failed each time,
-- fails 47->174), but rpc-atlas-market-drain (23 fails) and
-- rpc-allday-unmapped-atlas-resolver (17-19) were invisible at EVERY probe
-- because their latest tick happened to succeed. So the filter is a real gap,
-- and narrower than "it sees nothing".
--
-- This function is deliberately RATE-shaped and fleet-level: it answers "is the
-- INSTANCE unwell" rather than "is this job broken", which is the question that
-- took a two-hour manual investigation. It also covers the 11 of 134 active cron
-- jobs whose command is a bare REFRESH MATERIALIZED VIEW -- those provably write
-- no pipeline_runs row, so their failures are invisible to every existing arm.
--
-- ADDITIVE. Creates one new function; changes no existing object, no data, no
-- schedule. check_pgcron_recent_failures() is left exactly as it is: its
-- "currently broken" semantics are legitimately useful and it has no callers to
-- break.
--
-- REVERT: DROP FUNCTION public.check_pgcron_failure_rate(interval);

create or replace function public.check_pgcron_failure_rate(p_window interval default '6 hours'::interval)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  with runs as (
    select d.jobid, d.status, d.return_message
    from cron.job_run_details d
    where d.start_time > now() - p_window
      and d.status in ('failed', 'succeeded')
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
      -- Computed with a NOT clause rather than by subtraction, so it is exact
      -- and cannot go negative if a message ever matches both patterns.
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
    'top', coalesce(
      (select jsonb_agg(jsonb_build_object('jobname', t.jobname, 'fails', t.fails)) from top t),
      '[]'::jsonb)
  )
  from agg a
$fn$;

comment on function public.check_pgcron_failure_rate(interval) is
  'Fleet-level pg_cron failure RATE over p_window (default 6h), as one jsonb row: runs, fails, jobs_failing, startup_timeouts, statement_timeouts, other_fails, top 5 offenders. Added 2026-09-09 after a spell logged 399 failures against a 0-3/day baseline with nothing watching: the sentinel reads only pipeline_runs, and a job that fails to START writes no pipeline_runs row. Complements check_pgcron_recent_failures(), which filters to jobs whose LATEST run failed and therefore misses a high-rate intermittent failer (measured: 23-fail and 19-fail jobs invisible at every probe on 2026-09-09). Read this for "is the INSTANCE unwell"; read that one for "which job is broken now". Baseline for thresholding: 0-3 failures per DAY fleet-wide, 2026-09-02..08.';

-- A new function lands with default PUBLIC EXECUTE, which silently re-grants
-- what prior hardening removed. Revoke in ONE statement (either half alone
-- leaves a grant, via the PUBLIC default AND ALTER DEFAULT PRIVILEGES), then
-- grant only the roles that call it. Mirrors the grants already on the sibling
-- check_pgcron_recent_failures (verified live: postgres/service_role true,
-- anon/authenticated/cron_heavy false).
revoke execute on function public.check_pgcron_failure_rate(interval) from public, anon, authenticated;
grant execute on function public.check_pgcron_failure_rate(interval) to postgres, service_role;
