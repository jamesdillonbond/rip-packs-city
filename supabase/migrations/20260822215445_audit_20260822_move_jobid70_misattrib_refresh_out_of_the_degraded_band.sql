-- Move pg_cron jobid 70 (`rpc-refresh-misattrib-candidates`) from 15:35Z to 23:35Z.
--
-- WHY. It is the SOLE caller of refresh_topshot_misattrib_candidates(), and it had
-- failed 13 of its last 14 runs — twelve of them killed at the 600 s wall — leaving
-- mv_topshot_misattrib_candidates unrefreshed since 2026-08-16. 15:35Z sits deep in
-- the measured 01:00-19:00Z disk-IO degraded band. ⚠ The single SUCCESS in that
-- window (08-16) took 187.6 s, 4.2x under the wall, so the cost is CONTENTION, not
-- data growth, and moving the hour is the whole fix. Target minute verified
-- collision-free: zero active jobs fire at 23:35 (positive control: the identical
-- predicate returns jobid 70 itself at 15:35).
--
-- ⚠ WHY A MIGRATION AND NOT cron.alter_job: jobid 70 is owned by `cron_heavy`, and
-- `postgres` owns none of those jobs, so alter_job refuses. CLAUDE.md records the
-- working path — SET LOCAL ROLE cron_heavy inside a migration. `cron.schedule`
-- UPSERTS on (jobname, username), so running it AS the owning role updates the job
-- in place rather than creating a duplicate; the verification below asserts the
-- returned jobid is still 70.
--
-- ⚠ RESET ROLE IS LOAD-BEARING: apply_migration appends its own INSERT into
-- supabase_migrations.schema_migrations, which cron_heavy cannot write, so leaving
-- the role set fails the entire migration.
--
-- ⚠ NO GRANT IS MADE AND NONE IS NEEDED. cron_heavy already holds EXECUTE on
-- cron.schedule; the earlier proposal to grant it cron.alter_job would have widened
-- a privilege to buy a capability the role already had by another door.
--
-- The MV has no anon/authenticated SELECT and no view references it; its only reader
-- is the internal topshot_misattrib_drain_targets, so the refresh is invisible to users.
--
-- REVERT: SET LOCAL ROLE cron_heavy; SELECT cron.schedule('rpc-refresh-misattrib-candidates',
--   '35 15 * * *', 'SELECT public.refresh_topshot_misattrib_candidates()'); RESET ROLE;

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SET LOCAL ROLE cron_heavy;

  SELECT cron.schedule(
           'rpc-refresh-misattrib-candidates',
           '35 23 * * *',
           'SELECT public.refresh_topshot_misattrib_candidates()'
         )
    INTO v_jobid;

  -- The upsert MUST have updated jobid 70 in place. A different id means it created
  -- a duplicate job, which would leave TWO heavy refreshes scheduled — fail loudly
  -- and roll the whole thing back rather than leave that behind.
  IF v_jobid IS DISTINCT FROM 70 THEN
    RAISE EXCEPTION
      'cron.schedule returned jobid %, expected 70 — it created a DUPLICATE instead of upserting; rolling back',
      v_jobid;
  END IF;

  RESET ROLE;
END
$$;
