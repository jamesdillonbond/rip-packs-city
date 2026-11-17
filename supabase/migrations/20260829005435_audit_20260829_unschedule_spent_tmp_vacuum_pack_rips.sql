-- audit_20260829_unschedule_spent_tmp_vacuum_pack_rips
--
-- WHAT THIS IS. pg_cron jobid 379 `tmp-vacuum-pack-rips` was created as a ONE-SHOT
-- during the 2026-08-28 leaderboard/visibility-map work, on schedule `57 22 28 8 *`.
-- That is not a one-shot: day-of-month 28 + month 8 means it RE-FIRES at 22:57Z on
-- 28 August EVERY YEAR, indefinitely, as an unannounced VACUUM (ANALYZE) on
-- public.pack_rips owned by `postgres`.
--
-- WHY IT IS SAFE TO REMOVE. The job has already done its work and is spent:
--   cron.job_run_details jobid 379 -> exactly ONE run, 2026-08-28 22:57:00Z,
--   status `succeeded`, 33.6 s, return_message `VACUUM`.
-- Nothing is pending. Removing it drops no scheduled work; it only prevents an
-- unowned maintenance command re-appearing in a year, in a slot nobody will
-- remember allocating.
--
-- ⛔ SCOPE. This touches ONLY jobname 'tmp-vacuum-pack-rips'. It does NOT touch
-- jobid 380 `maint-vacuum-sales-hot-partition` (`20 10 * * *`,
-- `VACUUM (ANALYZE) public.sales_2026`), which is the DELIBERATE daily hedge
-- shipped alongside c26ae1981 and must stay.
--
-- GUARDED: asserts the job exists AND that its schedule and command are exactly
-- what was measured, so a renamed/repurposed job of the same name is refused
-- rather than silently unscheduled.
--
-- REVERT (restores the job exactly as it was):
--   SELECT cron.schedule('tmp-vacuum-pack-rips', '57 22 28 8 *',
--                        'VACUUM (ANALYZE) public.pack_rips');

DO $$
DECLARE
  v_cmd   text;
  v_sched text;
  v_left  int;
BEGIN
  SELECT command, schedule INTO v_cmd, v_sched
    FROM cron.job WHERE jobname = 'tmp-vacuum-pack-rips';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tmp-vacuum-pack-rips is not scheduled - nothing to unschedule (already removed?)';
  END IF;

  IF v_sched IS DISTINCT FROM '57 22 28 8 *' THEN
    RAISE EXCEPTION 'refusing: schedule is %, expected "57 22 28 8 *"', v_sched;
  END IF;

  IF v_cmd IS DISTINCT FROM 'VACUUM (ANALYZE) public.pack_rips' THEN
    RAISE EXCEPTION 'refusing: command is %, expected "VACUUM (ANALYZE) public.pack_rips"', v_cmd;
  END IF;

  PERFORM cron.unschedule('tmp-vacuum-pack-rips');

  SELECT count(*) INTO v_left FROM cron.job WHERE jobname = 'tmp-vacuum-pack-rips';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'post-condition failed: % rows still present for tmp-vacuum-pack-rips', v_left;
  END IF;

  -- positive control: the job we must NOT have touched is still there
  SELECT count(*) INTO v_left FROM cron.job WHERE jobname = 'maint-vacuum-sales-hot-partition';
  IF v_left <> 1 THEN
    RAISE EXCEPTION 'post-condition failed: maint-vacuum-sales-hot-partition count is %, expected 1', v_left;
  END IF;
END $$;
