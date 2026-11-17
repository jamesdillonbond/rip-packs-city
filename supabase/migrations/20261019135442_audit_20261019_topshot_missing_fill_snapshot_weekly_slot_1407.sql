-- audit_20261019_topshot_missing_fill_snapshot_weekly_slot_1407
-- Moves job `topshot-missing-fill-snapshot-weekly` (20261019135133) from Mondays 10:07 UTC to 14:07 UTC,
-- with the workflow's schedule moved to `23 14 * * 1` in the same change. Reason: the workflow existed
-- since 10-10 as dispatch-only, so scripts/check-scheduler-liveness.mjs (daily 08:17 UTC) would see a
-- schedule that has never fired and an old createdAt, and call it dead until the first Monday fire.
-- 14:07/14:23 UTC lets the first pair run today (Mon 2026-10-19), hours before the detector's next run.
-- REVERT: SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname='topshot-missing-fill-snapshot-weekly'), schedule := '7 10 * * 1');
SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'topshot-missing-fill-snapshot-weekly'), schedule := '7 14 * * 1');

DO $$
BEGIN
  IF (SELECT schedule FROM cron.job WHERE jobname = 'topshot-missing-fill-snapshot-weekly') <> '7 14 * * 1' THEN
    RAISE EXCEPTION 'topshot-missing-fill-snapshot-weekly not moved to 7 14 * * 1';
  END IF;
END
$$;
