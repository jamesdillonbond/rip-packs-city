-- audit_20260830_weekly_log_purges_watchlist_note_names_the_new_slot_and_the_startup_timeout_cause
--
-- TWO STALE CLAIMS in the live `weekly-db-maintenance` cadence note, found while
-- triaging its CURRENT breach (silent 2,614 min against a 1,800 min arm).
--
-- 1. THE SLOT MOVED AND THE NOTE DID NOT. The note says "Runs on pg_cron jobid
--    198 (rpc-weekly-log-purges) DAILY 09:40 UTC". `cron.job.schedule` is now
--    `46 11 * * *` -- moved off the 09Z storm band by migration
--    20260830000048. A reader triaging the breach goes to 09:40, finds nothing,
--    and concludes the scheduler died. Same drift the register already records
--    correcting for candy-editions-ingest.
--
-- 2. THE NOTE NAMES NO CAUSE FOR A MISSED DAILY TICK, and the commonest one is
--    not a code fault. Measured over cron.job_run_details (51 days, 188,316
--    runs): `job startup timeout` is **3,034 events across 84 jobs -- ~70% of
--    ALL pg_cron failures**, and it means the job never STARTED, so it writes no
--    pipeline_runs row and presents as SILENCE. jobid 198 hit it on 08-29 09:54,
--    08-25 09:40 and 08-24 09:40.
--
-- ⭐ THE ASYMMETRY IS THE POINT, and it is why this arm breaches while nothing
-- is wrong: the per-tick startup-timeout rate is a fairly uniform **3-4% on the
-- high-frequency jobs** (rpc-pinnacle-mints-backfill 381/10,042 = 3.8%;
-- rpc-allday-pack-sales-backfill 237/6,565 = 3.6%; worst observed 5.8%). A `*/2`
-- job absorbs a lost tick invisibly. A DAILY job cannot -- one lost tick is a
-- 48-hour gap against a 30-hour arm. **The same background loss rate is noise on
-- a frequent job and a page on a daily one.**
--
-- ⛔ A TEMPTING MECHANISM, MEASURED AND REFUTED -- do not re-derive it.
-- `cron.max_running_jobs` is 32 while `max_worker_processes` is 6, which looks
-- like pg_cron promising 32 slots the server cannot supply. **Observed
-- concurrency reaches 11**, so worker-process exhaustion at 6 is NOT the
-- mechanism. The cause remains unestablished; it is a capacity symptom on an
-- IO-bound Small instance, and this note does not guess further.
--
-- NOT CHANGED: severity (info), max_silent_minutes (1800), is_active. The arm is
-- correct -- a daily job silent for 30h IS worth a look. Only the note is wrong.
--
-- REVERT:
--   UPDATE public.pipeline_cadence_watchlist w SET notes = b.notes
--     FROM public.audit_20260830_weekly_maint_note_backup b
--    WHERE w.pipeline = b.pipeline;
--   DROP TABLE public.audit_20260830_weekly_maint_note_backup;
-- ⚠ Named explicitly -- other sessions write into the audit_20260830_ prefix, so
-- never wildcard-drop it.

CREATE TABLE IF NOT EXISTS public.audit_20260830_weekly_maint_note_backup AS
SELECT pipeline, notes FROM public.pipeline_cadence_watchlist
WHERE pipeline = 'weekly-db-maintenance';

-- RLS on, no policies: service_role only -- the standing convention for audit_*
-- tables here, and enforced by the smoke suite's "public base tables: RLS on" arm.
ALTER TABLE public.audit_20260830_weekly_maint_note_backup ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.audit_20260830_weekly_maint_note_backup IS
  'Revert copy of pipeline_cadence_watchlist.notes for weekly-db-maintenance, taken 2026-08-29 PT before naming the moved 11:46Z slot and the job-startup-timeout cause. RLS on, no policies: service_role only. Safe to drop once accepted; do NOT wildcard-drop the audit_20260830_ prefix.';

UPDATE public.pipeline_cadence_watchlist
SET notes = replace(
      notes,
      'Runs on pg_cron jobid 198 (rpc-weekly-log-purges) DAILY 09:40 UTC as postgres',
      'Runs on pg_cron jobid 198 (rpc-weekly-log-purges) DAILY 11:46 UTC as postgres (MOVED 2026-08-30 off the 09Z storm band by migration 20260830000048 -- the note said 09:40 until 2026-08-29, so ignore any older reference to that slot)'
    )
WHERE pipeline = 'weekly-db-maintenance';

UPDATE public.pipeline_cadence_watchlist
SET notes = notes || E'\n\n⚠ BEFORE DIAGNOSING A BREACH HERE AS A CODE FAULT, CHECK cron.job_run_details FOR `job startup timeout`. That is pg_cron failing to START the job -- it never runs, so it writes NO pipeline_runs row and presents as SILENCE, not failure. jobid 198 hit it on 2026-08-29 09:54, 08-25 09:40 and 08-24 09:40. Fleet-wide it is 3,034 events / 84 jobs over 51 days, ~70% of ALL pg_cron failures, at a fairly uniform 3-4% per-tick rate. ⭐ A */2 job absorbs a lost tick invisibly; a DAILY job cannot -- one lost tick is a 48h gap against this 30h arm. So an occasional breach here is EXPECTED and is not evidence the purge is broken; confirm by reading the last cron.job_run_details row rather than the silence. ⛔ The obvious mechanism was measured and REFUTED: cron.max_running_jobs=32 vs max_worker_processes=6 looks like the cause, but observed concurrency reaches 11, so it is not worker exhaustion at 6.'
WHERE pipeline = 'weekly-db-maintenance';
