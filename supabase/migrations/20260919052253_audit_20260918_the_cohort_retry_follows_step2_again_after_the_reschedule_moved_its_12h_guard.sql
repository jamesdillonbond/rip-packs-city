-- 2026-09-18 evening audit (Cowork cloud). AUTHORED 22:25 PT 09-18 = 05:25Z 09-19.
-- Closes a landmine the SAME PASS created in migration 20260919055500.
--
--   rpc-ccm-step2-retry (jobid 491, owner postgres, ACTIVE = false)  '37 4 * * *' -> '47 15 * * *'
--
-- WHY. Job 491 is a self-guarding backstop, not a sequential follow-up: its body runs
-- refresh_cross_collection_cohort_step2() only IF cross_collection_ts_set_overlap_mat is older
-- than 12 hours. That guard is arithmetic against step2's schedule, and this pass moved step2.
--
--   BEFORE  step2 23:25Z, retry 04:37Z  -> mat age at the retry =  5 h 12 m  < 12 h -> no-op on success.
--   AFTER   step2 10:35Z, retry 04:37Z  -> mat age at the retry = 18 h 02 m  > 12 h -> FIRES EVERY DAY.
--
-- So the reschedule silently converted a failure-only backstop into a daily 300 s step2 at
-- 9:37 PM PT. The job is INACTIVE (a ledger-recorded pause), so there is no live impact today --
-- but a paused job is exactly the kind of thing that gets re-enabled, and it would have been
-- re-enabled into a shape nobody chose. Fixing it while it is still inactive is the cheap moment.
--
-- ⭐ REUSABLE: a schedule change is not local. Anything downstream that guards on "older than N
--    hours" is arithmetic against the schedule you just moved, and the failure is SILENT because
--    the guard still reads true -- it just reads true every day now instead of only after a failure.
--    Grep the estate for age-guarded followers before moving a producer.
--
-- DESTINATION 15:47Z = 8:47 AM PT: 5 h 12 m after step2's new 10:35Z, which restores the ORIGINAL
-- margin exactly rather than inventing a new one. Chosen against the live cron.job table, not a doc:
-- UTC hours 15 and 16 contain NO daily jobs at all, and 8 AM PT is one of the quietest hours on the
-- 7-day profile (305.3 busy-min/7d, 21 timeouts, avg 6.82 s).
--
-- NOT DONE: the job is left INACTIVE. This migration moves WHEN it would run, and does not decide
-- whether it should. Re-enabling it is a separate call, and R109 says step2's input will likely
-- still be stale, so a working retry is not obviously the thing you want yet.
--
-- REVERT: select cron.alter_job(491, schedule => '37 4 * * *');

DO $mig$
DECLARE
  v_before text;
  v_after  text;
  v_active boolean;
  v_owner  text;
BEGIN
  SELECT schedule, active, username INTO v_before, v_active, v_owner
    FROM cron.job WHERE jobid = 491 AND jobname = 'rpc-ccm-step2-retry';

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'jobid 491 is not rpc-ccm-step2-retry - refusing to move a job I cannot identify';
  END IF;

  IF v_before = '47 15 * * *' THEN
    RAISE NOTICE 'retry already on the destination schedule - no change';
    RETURN;
  END IF;

  IF v_before <> '37 4 * * *' THEN
    RAISE EXCEPTION 'retry is not on the measured schedule (found %) - re-derive before moving it',
      v_before;
  END IF;

  -- NON-VACUITY on the premise: this fix only makes sense if step2 actually moved to 10:35Z.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-ccm-step2' AND schedule = '35 10 * * *') THEN
    RAISE EXCEPTION 'step2 is not at 35 10 - the 12h-guard arithmetic this migration corrects '
      'does not apply, so do not move the retry';
  END IF;

  PERFORM cron.alter_job(491, schedule => '47 15 * * *');

  SELECT schedule, active INTO v_after, v_active FROM cron.job WHERE jobid = 491;

  IF v_after <> '47 15 * * *' THEN
    RAISE EXCEPTION 'retry reschedule did not take (found %)', v_after;
  END IF;

  -- It must come out of this STILL PAUSED. Waking a paused job by accident is the failure mode.
  IF v_active THEN
    RAISE EXCEPTION 'retry came out ACTIVE - this migration must not un-pause it';
  END IF;

  RAISE NOTICE 'retry moved % -> %, still inactive', v_before, v_after;
END
$mig$;
