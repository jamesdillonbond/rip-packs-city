-- audit_20260918_cron_job_run_details_keeps_30_days
--
-- `cron.job_run_details` had NO retention: 330k rows / 189 MB back to 2026-07-09, and
-- nothing purges it (pg_cron never does on its own — its docs ask the operator to).
-- Measured tonight in the 2-hourly pg_stat_statements snapshot delta (00:05 → 02:05Z):
-- two one-off diagnostic aggregations over this table read 624,700 and 577,663 blocks
-- (4.8 GB and 4.4 GB) — the #5 and #6 disk readers of the window, on an instance whose
-- whole budget is 22 MB/s, during a saturation spell those very aggregations were
-- trying to explain. Every instrument that reads this table (check_pgcron_failure_rate,
-- the fleet-health arms, any session's "which lane is failing") pays the same.
--
-- 30 days, daily at 04:47Z (a quiet minute; nothing else on :47 at 4 UTC). 30, not 7,
-- because the 2026-09-19 01:30Z filing derived an hour-of-day baseline over 8 days and
-- the register's R101 row cites a 12-day trend; a month keeps both derivable.
-- The DELETE runs as postgres (the table's owner here). Its first run removes ~2 months
-- of rows in one statement; after that it is a few hundred rows a day.
--
-- REVERT: DO $$ BEGIN PERFORM cron.unschedule('rpc-cron-log-retention'); END $$;
--         (rows already deleted are gone — they were the point.)

DO $mig$
DECLARE v_new int;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-cron-log-retention') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: rpc-cron-log-retention already scheduled';
  END IF;
  v_new := cron.schedule('rpc-cron-log-retention', '47 4 * * *',
    $j$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '30 days'$j$);
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_new AND active) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: job % not active', v_new;
  END IF;
  RAISE NOTICE 'rpc-cron-log-retention scheduled as jobid % (47 4 * * *, 30 days)', v_new;
END
$mig$;
