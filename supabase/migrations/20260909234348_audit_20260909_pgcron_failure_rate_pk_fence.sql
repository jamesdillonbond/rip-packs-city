-- audit_20260909_pgcron_failure_rate_pk_fence
--
-- WHY: the arm shipped an hour ago cost 18,313 PHYSICAL buffer reads (~143 MB)
-- per call. Measured with EXPLAIN (ANALYZE, BUFFERS) rather than timings, per
-- CLAUDE.md. Cause: cron.job_run_details holds 249,731 rows / 143 MB retained
-- since 2026-07-09 and its ONLY index is the runid primary key -- nothing on
-- start_time -- so `where start_time > now() - p_window` seq-scans the whole
-- table to find the 2,174 rows a 6h window actually matches (0.87%).
--
-- ⛔ An arm about IO saturation that itself reads 143 MB per sweep is a defect,
-- and it degrades: the table has no retention policy and grows ~8,700 rows/day.
--
-- ⛔ The obvious fix is unavailable, and that was TESTED not assumed:
-- cron.job_run_details is owned by supabase_admin and `postgres` is not a member
-- (pg_has_role -> false), so an index on start_time cannot be created from here.
-- Same class as known-issues #60 (the net/cron grants belong to supabase_admin).
--
-- SO: fence the scan on the PRIMARY KEY, which is dense and monotonic, and keep
-- start_time as the CORRECTNESS filter. Measured: runid spans 2,173 over 6h and
-- 8,703 over 24h, i.e. ~362/h, so the fence is sized at 3,000/h with a 50,000
-- floor -- roughly 8x the observed rate, and it SCALES with p_window instead of
-- being a constant that silently tightens as traffic grows.
--
-- ⭐ AND THE FENCE IS PROVEN NOT TO BIND, rather than assumed generous. A
-- performance fence that cuts the window short would silently UNDER-COUNT
-- failures -- the exact failed-read-as-fact shape this arm exists to catch. The
-- payload now carries `complete`: true only when the fenced set reaches back
-- PAST the window start, so a bound fence is reported as a lower bound instead
-- of published as a count.
--
-- Same signature, so grants are preserved (no new overload) -- re-verified after.
--
-- REVERT: re-apply migration 20260909233213's body (the unfenced version).
--
-- anon-exec: already-revoked (check_pgcron_failure_rate) — the marker must name the
-- function on its OWN line; this is a SAME-SIGNATURE `create or replace`, and a
-- replace does NOT reset a function ACL, so check_pgcron_failure_rate keeps the
-- grants migration 20260909233213 set on it (anon/authenticated revoked in one
-- statement, postgres + service_role granted). Adding a revoke here would be a
-- claim about production this migration does not make. Re-verified live after
-- applying: anon false, authenticated false, service_role true, postgres true,
-- exactly 1 overload.

create or replace function public.check_pgcron_failure_rate(p_window interval default '6 hours'::interval)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  with bounds as (
    select
      (select max(d.runid) from cron.job_run_details d) as max_runid,
      greatest(
        50000::bigint,
        (ceil(extract(epoch from p_window) / 3600.0) * 3000)::bigint
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

comment on function public.check_pgcron_failure_rate(interval) is
  'Fleet-level pg_cron failure RATE over p_window (default 6h), as one jsonb row: runs, fails, jobs_failing, startup_timeouts, statement_timeouts, other_fails, complete, top 5 offenders. Added 2026-09-09 after a spell logged 399 failures against a 0-3/day baseline with nothing watching: the sentinel reads only pipeline_runs, and a job that fails to START writes no pipeline_runs row. Complements check_pgcron_recent_failures(), which filters to jobs whose LATEST run failed and therefore misses a high-rate intermittent failer (measured: 23-fail and 19-fail jobs invisible at every probe on 2026-09-09). PERFORMANCE: cron.job_run_details has no index on start_time and is owned by supabase_admin (postgres cannot add one - see known-issues #60), so the scan is fenced on the runid PK, sized at 3,000/h with a 50,000 floor against a measured ~362/h. `complete` is false when that fence bound the window, in which case every count is a LOWER BOUND. Baseline for thresholding: 0-3 failures per DAY fleet-wide, 2026-09-02..08.';
