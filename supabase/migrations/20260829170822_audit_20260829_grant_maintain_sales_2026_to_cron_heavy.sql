-- audit_20260829_grant_maintain_sales_2026_to_cron_heavy
--
-- WHY. pg_cron jobid 380 `maint-vacuum-sales-hot-partition` (`20 10 * * *`,
-- `VACUUM (ANALYZE) public.sales_2026`, installed by 20260829002812) has run exactly
-- once, 2026-08-29 10:20:00.386Z, and was cancelled at 120.08 s with
--   ERROR: canceling statement due to statement timeout
--   CONTEXT: while scanning relation "public.sales_2026"
-- Read live from cron.job / cron.job_run_details at 2026-08-29 17:00Z.
--
-- THE CAUSE, MEASURED, AND IT IS NOT WHAT THE 15:15Z NOTE SAID. jobid 380's
-- cron.job.username is `postgres`, and has_table_privilege('postgres',
-- 'public.sales_2026','MAINTAIN') is TRUE -- so a missing MAINTAIN is NOT what
-- stopped it. `postgres` carries NO statement_timeout in pg_roles.rolconfig
-- (rolconfig = {search_path=...}) and therefore inherits the cluster's 120 s.
-- The 120.08 s cancellation is that budget, exactly.
--
-- WHAT THIS MIGRATION DOES, AND WHAT IT DELIBERATELY DOES NOT DO. The repair that
-- gives the job a 600 s budget is to re-own it to `cron_heavy`
-- (pg_roles.rolconfig = {statement_timeout=600s}). pg_cron keys on
-- (jobname, username), so that repair MUST be unschedule + re-schedule under
-- SET LOCAL ROLE cron_heavy and the jobid WILL change. That half is a scheduling
-- change on a live maintenance job and is QUEUED FOR TREVOR, not self-approved.
--
-- But `cron_heavy` today has has_table_privilege(...,'MAINTAIN') = FALSE, and a
-- re-own performed WITHOUT this grant produces the worst available outcome: VACUUM
-- is SKIPPED with a WARNING and pg_cron records the run as "succeeded". This
-- migration removes that failure mode IN ADVANCE, so the queued repair becomes a
-- single safe step instead of an ordered pair where one order lies.
--
-- WHY IT IS SAFE TODAY, VERIFIED NOT ASSUMED. No cron_heavy job references
-- sales_2026: `SELECT jobid, jobname FROM cron.job WHERE username='cron_heavy' AND
-- command ILIKE '%sales_2026%'` returns ZERO rows (read 17:04Z). MAINTAIN is not a
-- data privilege -- it confers VACUUM / ANALYZE / REINDEX / CLUSTER /
-- REFRESH MATERIALIZED VIEW / LOCK TABLE and no SELECT, INSERT, UPDATE or DELETE.
-- `cron_heavy` is an internal pg_cron role; it is not `anon` and not
-- `authenticated`. So this grant changes NO behaviour until the queued repair runs.
--
-- REVERT (one statement):
--   REVOKE MAINTAIN ON TABLE public.sales_2026 FROM cron_heavy;

DO $mig$
BEGIN
  SET LOCAL lock_timeout = '5s';

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cron_heavy') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: role cron_heavy does not exist';
  END IF;

  IF to_regclass('public.sales_2026') IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: public.sales_2026 does not exist';
  END IF;

  -- Assert the state this migration was reasoned about: cron_heavy has no MAINTAIN
  -- yet. If a concurrent session already granted it, stop rather than no-op silently.
  IF has_table_privilege('cron_heavy', 'public.sales_2026', 'MAINTAIN') THEN
    RAISE EXCEPTION
      'PRE-STATE FAILED: cron_heavy ALREADY holds MAINTAIN on public.sales_2026 -- '
      'someone else changed this; re-read before acting';
  END IF;

  -- Assert the safety claim rather than trusting the comment above.
  IF EXISTS (SELECT 1 FROM cron.job
             WHERE username = 'cron_heavy' AND command ILIKE '%sales_2026%') THEN
    RAISE EXCEPTION
      'PRE-STATE FAILED: a cron_heavy job now references sales_2026 -- this grant is '
      'no longer behaviour-neutral; re-evaluate';
  END IF;

  GRANT MAINTAIN ON TABLE public.sales_2026 TO cron_heavy;

  -- Post-state readback inside the same transaction.
  IF NOT has_table_privilege('cron_heavy', 'public.sales_2026', 'MAINTAIN') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: MAINTAIN not present after GRANT';
  END IF;
END
$mig$;
