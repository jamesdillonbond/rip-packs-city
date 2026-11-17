-- 2026-09-02 — `REVOKE ... FROM PUBLIC` silently un-schedules a `cron_heavy` job.
--
-- 🚨 CAUGHT IN PRODUCTION 30 MINUTES AFTER SHIPPING, BY ITS OWN FIRST TICK. Migration
-- 20260902112507 created `run_topshot_onchain_rekey()` and hardened it the way this repo
-- requires of every new public function:
--
--     REVOKE EXECUTE ON FUNCTION public.run_topshot_onchain_rekey() FROM PUBLIC, anon, authenticated;
--
-- pg_cron jobid 434 then fired at 11:33 UTC and died in **0.0 s** with
-- `ERROR: permission denied for function run_topshot_onchain_rekey`.
--
-- ⚠ THE TWO STANDING POLICIES ARE IN DIRECT CONFLICT AND NOTHING SAID SO. A new
-- function in `public` is executable by `cron_heavy` ONLY through the PUBLIC grant it
-- inherits at creation — `cron_heavy` gets nothing from `ALTER DEFAULT PRIVILEGES`, which
-- on this database covers `anon`, `authenticated` and `service_role`. So the mandated
-- anon hardening removes exactly the grant the mandated scheduler needs, and the two
-- rules were written in different passes by people solving different problems.
--
-- ⚠ THE FAILURE MODE IS THE DANGEROUS PART, NOT THE ERROR. It fails in 0.0 s, writes NO
-- `pipeline_runs` row (the function never runs, so it never logs), and leaves the message
-- only in `cron.job_run_details` — which no fleet sweep in this repo reads. A job in this
-- state is indistinguishable from a job that was never scheduled: silent, free, and
-- green everywhere anyone looks. Had the first tick not been watched deliberately this
-- would have sat dead until someone asked why the re-key stopped.
--
-- ── THE FIX, AND THE CONTROL THAT SHOWS IT IS THE ESTABLISHED CONVENTION ────────────
-- Every one of the other 48 functions reachable from an active `cron_heavy` job command
-- already carries an EXPLICIT `cron_heavy=X/postgres` in its acl (checked live: 48 of 49
-- executable, anon/authenticated false on all 49 — `run_topshot_onchain_rekey` was the
-- sole exception, i.e. this was a missing line, not a new idea). The acl of a working
-- sibling is exactly:
--     postgres=X/postgres | service_role=X/postgres | cron_heavy=X/postgres
--
-- ── AND A GUARD, BECAUSE THE NEXT ONE WILL NOT BE WATCHED ───────────────────────────
-- `check_cron_heavy_job_exec_drift()` derives its population from `cron.job` by TREE
-- WALK rather than a curated list, so a job scheduled tomorrow is inside it by
-- construction. It returns `{inspected, offenders}` — `inspected` is there so a run that
-- examined NOTHING (a regex that stopped matching, a renamed catalog) cannot read as a
-- clean bill of health, which is this repo's standing rule about guards that pass by
-- inspecting an empty set.
--
-- ⚠ Overloads: a name is an offender only when NO overload of it is executable by
-- `cron_heavy`. Flagging per-oid would fire on any function that has an unused overload,
-- which is a false positive, and a guard with false positives gets muted.

GRANT EXECUTE ON FUNCTION public.run_topshot_onchain_rekey() TO cron_heavy;

CREATE OR REPLACE FUNCTION public.check_cron_heavy_job_exec_drift()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH called AS (
    SELECT j.jobid, j.jobname, (regexp_matches(j.command, 'public\.([a-z0-9_]+)\s*\(', 'g'))[1] AS fname
    FROM cron.job j
    WHERE j.username = 'cron_heavy' AND j.active
  ),
  resolved AS (
    SELECT c.jobid, c.jobname, c.fname,
           bool_or(has_function_privilege('cron_heavy', p.oid, 'EXECUTE')) AS any_overload_ok
    FROM called c
    JOIN pg_proc p ON p.proname = c.fname
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    GROUP BY c.jobid, c.jobname, c.fname
  )
  SELECT jsonb_build_object(
    'inspected', (SELECT count(*) FROM resolved),
    'offenders', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('jobid', jobid, 'jobname', jobname, 'function', fname)
                        ORDER BY jobid)
         FROM resolved WHERE NOT any_overload_ok),
      '[]'::jsonb)
  );
$fn$;

REVOKE EXECUTE ON FUNCTION public.check_cron_heavy_job_exec_drift() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.check_cron_heavy_job_exec_drift() IS
  'Ban at population zero: every function named in an ACTIVE cron_heavy job command must be '
  'EXECUTE-able by cron_heavy. A new public function inherits execute only via the PUBLIC '
  'grant, so the mandated REVOKE ... FROM PUBLIC un-schedules it silently — jobid 434 died '
  'at 0.0s this way on 2026-09-02 with no pipeline_runs row and the message only in '
  'cron.job_run_details. Returns {inspected, offenders}: read the offenders ARRAY LENGTH, '
  'and treat inspected = 0 as a broken guard rather than a clean run.';

DO $mig$
DECLARE
  v jsonb;
BEGIN
  IF NOT has_function_privilege('cron_heavy', 'public.run_topshot_onchain_rekey()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the grant did not take: cron_heavy still cannot execute run_topshot_onchain_rekey';
  END IF;
  -- The hardening must SURVIVE the grant — this is the whole point of granting the one
  -- role instead of restoring PUBLIC.
  IF has_function_privilege('anon', 'public.run_topshot_onchain_rekey()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.run_topshot_onchain_rekey()', 'EXECUTE') THEN
    RAISE EXCEPTION 'run_topshot_onchain_rekey became anon/authenticated executable; the grant was too wide';
  END IF;

  v := public.check_cron_heavy_job_exec_drift();
  IF (v->>'inspected')::int < 20 THEN
    RAISE EXCEPTION 'check_cron_heavy_job_exec_drift inspected only % job/function pairs — the walk is broken, not clean. %',
      v->>'inspected', v;
  END IF;
  IF jsonb_array_length(v->'offenders') <> 0 THEN
    RAISE EXCEPTION 'cron_heavy cannot execute a function it is scheduled to call: %', v->'offenders';
  END IF;
END
$mig$;
