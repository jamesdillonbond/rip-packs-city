-- audit_20260910_cron_exec_drift_walks_every_role_and_states_what_it_could_not_test
--
-- WHY: check_cron_heavy_job_exec_drift filtered `WHERE j.username = 'cron_heavy'`,
-- so it inspected 58 job/function pairs and was structurally SILENT about the
-- 55 pairs belonging to the 55 ACTIVE jobs that run as `postgres` -- 49% of the
-- scheduled population, invisible to the guard by construction.
--
-- ⭐ AND THE FILTER TURNS OUT TO BE CORRECT, WHICH IS THE FINDING. I set out to
-- widen it as a gap and measurement refuted that: `postgres` OWNS all 54 public
-- functions its own cron jobs call, and an owner's EXECUTE cannot be revoked, so
-- has_function_privilege('postgres', fn, 'EXECUTE') is unconditionally true for
-- every one of those pairs. Simply widening the WHERE would have added 55
-- VACUOUS assertions -- a test that cannot fail, reading as coverage, which this
-- repo names as the worst kind. (`postgres` is also not a superuser here;
-- rolsuper is false and only supabase_admin has it. Ownership, not superuser,
-- is what makes those pairs immune.)
--
-- ⛔ So the scope was right for a reason NOBODY WROTE DOWN and NOTHING ENFORCED.
-- That is the actual defect: the guard's blast radius was pinned to a role name
-- rather than to the PROPERTY that makes a pair testable, and the day a job is
-- scheduled under a role that does not own its target function, the role-name
-- filter silently fails to cover it.
--
-- FIX: walk EVERY active job, and split the population by the property instead
-- of the role name:
--   inspected    -- every active job/function pair found (113 today, was 58)
--   immune_owner -- pairs where the calling role OWNS the function, so its
--                   EXECUTE cannot be revoked and this guard tests nothing (55)
--   revocable    -- pairs the guard ACTUALLY tests (58; all cron_heavy today)
--   offenders    -- revocable pairs where EXECUTE is missing (0)
-- Reading `inspected` as "how much was tested" is now impossible: the payload
-- says what it could not test and why. A future non-owning role is covered
-- automatically, with no edit to this function.
--
-- BAN AT POPULATION ZERO, no debt: offenders = 0 today.
--
-- ⭐ POSITIVE CONTROL, two-way, on live objects and without mutating anything:
-- over the 51 distinct functions cron_heavy is scheduled to call,
-- has_function_privilege reads TRUE for cron_heavy on 51/51 and FALSE for anon
-- on 0/51 -- so the predicate is not a constant, it can report an offender. And
-- cron_heavy owns 0 of the 51, confirming its EXECUTE is grant-derived and
-- therefore genuinely revocable, which is what makes those 58 pairs a real test.
--
-- SAME SIGNATURE (no args), so this is a create-or-replace: the ACL is untouched
-- and no new overload appears. The payload only GAINS keys, so the existing
-- smoke-test arm -- which reads {inspected, offenders} and floors inspected at
-- 20 -- keeps working unchanged.
--
-- anon-exec: already-revoked (check_cron_heavy_job_exec_drift) -- same-signature
-- create-or-replace does not reset a function ACL, so the grants set by
-- audit_20260902_revoke_from_public_silently_unschedules_a_cron_heavy_job stand.
-- Verified before applying: anon false, authenticated false, service_role true,
-- postgres true, exactly 1 overload -- and re-verified after.
--
-- REVERT: re-apply the body from
-- audit_20260902_revoke_from_public_silently_unschedules_a_cron_heavy_job.

create or replace function public.check_cron_heavy_job_exec_drift()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  with called as (
    select j.jobid, j.jobname, j.username,
           (regexp_matches(j.command, 'public\.([a-z0-9_]+)\s*\(', 'g'))[1] as fname
    from cron.job j
    where j.active
  ),
  resolved as (
    select c.jobid, c.jobname, c.username, c.fname,
           bool_or(has_function_privilege(c.username, p.oid, 'EXECUTE')) as any_overload_ok,
           -- An owner's EXECUTE cannot be revoked. Such a pair is structurally
           -- immune, so it is reported separately and NEVER counted as tested.
           bool_and(pg_get_userbyid(p.proowner) = c.username) as owned_by_caller
    from called c
    join pg_proc p on p.proname = c.fname
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
    group by c.jobid, c.jobname, c.username, c.fname
  )
  select jsonb_build_object(
    'inspected',    (select count(*) from resolved),
    'immune_owner', (select count(*) from resolved where owned_by_caller),
    'revocable',    (select count(*) from resolved where not owned_by_caller),
    'offenders', coalesce(
      (select jsonb_agg(jsonb_build_object(
                 'jobid', jobid, 'jobname', jobname,
                 'role', username, 'function', fname)
               order by jobid)
         from resolved
        where not owned_by_caller and not any_overload_ok),
      '[]'::jsonb)
  );
$fn$;

comment on function public.check_cron_heavy_job_exec_drift() is
  'Ban at population zero: every ACTIVE cron job must be able to EXECUTE the public function its command names. A new public function inherits execute only via the PUBLIC grant, so the mandated REVOKE ... FROM PUBLIC un-schedules it silently -- jobid 434 died at 0.0s this way on 2026-09-02, and jobid 481 again on 2026-09-09, both with no pipeline_runs row and the message only in cron.job_run_details. WIDENED 2026-09-10 from a WHERE username = ''cron_heavy'' filter to every role, because a role-name filter pins the blast radius to a name rather than to the property that makes a pair testable. Returns {inspected, immune_owner, revocable, offenders}. READ THE OFFENDERS ARRAY LENGTH, not the row count. ⚠ inspected is NOT how much was tested: a pair whose calling role OWNS the function cannot have its EXECUTE revoked, so it is counted in immune_owner and tested by nothing -- today that is all 55 postgres pairs, since postgres owns all 54 functions its jobs call. `revocable` is the population this guard actually tests (58 today, all cron_heavy). Treat inspected = 0 OR revocable = 0 as a broken guard rather than a clean run.';
