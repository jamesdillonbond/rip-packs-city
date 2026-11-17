-- ⛔ FIXES A DEFECT IN THE MIGRATION SHIPPED ~40 MINUTES EARLIER TODAY
-- (`..._ccm_step2_gets_a_conditional_retry_...`). `rpc-ccm-step2-retry` (jobid 491)
-- was scheduled with NO `statement_timeout` in its command, so it would have been
-- capped at the CLUSTER GLOBAL 120 s and killed before finishing — a retry that
-- fires, burns 120 s, dies, and leaves the mat exactly as stale as it found it,
-- while `cron.job_run_details` records that it ran.
--
-- ⭐ WHY 120 s AND NOT THE FUNCTION'S OWN 300 s, verified rather than assumed:
--   · `pg_settings.statement_timeout` reset_val = 120000, source = configuration file.
--   · `pg_db_role_setting` grants overrides to anon (3 s), authenticated/authenticator
--     (8 s), service_role (30 s) and cron_heavy (600 s). **`postgres` has NO entry**,
--     and jobid 491 runs as `postgres`. So the global binds.
--   · ⛔ `refresh_cross_collection_cohort_step2()` DECLARES `SET statement_timeout
--     TO '300s'` in its `proconfig`, and that CANNOT save it: the statement timer is
--     armed by `start_xact_command()` BEFORE the function's GUC nest level is entered,
--     so a function-level declaration can neither raise nor lower the budget of the
--     statement that invokes it. This repo has already paid for that lesson once —
--     8 pg_cron jobs silently capped at the global 120 s while their functions
--     declared 180–600 s, every one dying at exactly 120.0 s.
--
-- ⭐ THE POSITIVE CONTROL THAT THE IN-COMMAND `SET` DOES BIND — measured, not argued:
-- the PRIMARY (jobid 4) carries `SET statement_timeout = '300s';` in its command and
-- has a recorded successful run of **165.2 s on 2026-09-10**. A run that exceeds 120 s
-- and still completes is only possible if the in-command SET took effect. So the fix
-- below is the same mechanism that is already working one job over, not a guess.
--
-- ⚠ AND IT MATTERS IN PRACTICE, not just in theory: a manual cold call of this
-- function on a CALM instance (io_wait 2, active 4) exceeded 120 s today. The retry
-- would have hit the cap on a normal day, not only during a spell.
--
-- ⭐ `cron.schedule` on an EXISTING job name updates in place and PRESERVES the jobid
-- (491) — deliberately not unschedule+reschedule, which churns the jobid and breaks
-- anything keyed on it.
--
-- Everything else is unchanged: still staleness-GATED at 12 h so it takes the
-- ACCESS EXCLUSIVE lock on `cross_collection_ts_set_overlap_mat` (read by the public,
-- crawlable /insights/cross-collection board) only on the ~7 % of days the primary
-- fails, and `COALESCE(…, '-infinity')` still fires on an EMPTY mat rather than
-- reading NULL as fresh.
--
-- REVERT: SELECT cron.unschedule('rpc-ccm-step2-retry');

SELECT cron.schedule(
  'rpc-ccm-step2-retry',
  '37 4 * * *',
  $job$
  SET statement_timeout = '300s';
  DO $retry$
  BEGIN
    IF (SELECT COALESCE(MAX(computed_at), '-infinity'::timestamptz)
          FROM public.cross_collection_ts_set_overlap_mat)
       < NOW() - INTERVAL '12 hours'
    THEN
      PERFORM public.refresh_cross_collection_cohort_step2();
    END IF;
  END
  $retry$;
  $job$
);
