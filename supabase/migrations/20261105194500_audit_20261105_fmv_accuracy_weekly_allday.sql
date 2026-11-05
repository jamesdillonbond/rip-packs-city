-- audit_20261105_fmv_accuracy_weekly_allday — 2026-11-05 ~11:45 AM PT (Claude Code cloud, autonomous daytime pass;
-- Trevor: "work through any known issues, roadmap items, handoffs"). #234 EXIT step (2).
--
-- fmv_accuracy_weekly (20261105040000) is filled for Top Shot only (pg_cron rpc-fmv-accuracy-weekly, jobid 828).
-- #234's exit asks for All Day beside it, so the 11-04 All Day pricing change (LOW unknown-depth haircut 0.55 -> 0.75,
-- 20261105050000) and the All Day M2 gate get the same weekly scorecard.
--
-- refresh_fmv_accuracy_weekly(p_collection, p_week_start) is already collection-generic (read 11-05 ~11:43 AM PT:
-- every predicate is keyed on p_collection; serial > 25 and the price bands are the same as Top Shot's). So this is
-- a second SCHEDULE only — no function or table change.
--
-- Slot: Mondays 11:45 UTC = 3:45 AM PST, eight minutes after the Top Shot job (11:37). Read 11-05: no other job is
-- scheduled at minute 45 of hour 11 on any day. Cost bound: All Day has ~3.5k market sales a week against Top Shot's
-- ~16k (fmv_sales_backtest 7 d, 11-05: n 3,574 vs 16,525), and the per-sale work (two indexed LIMIT-1 laterals) is
-- the same, so a run is a fraction of the Top Shot job's.
--
-- Baseline: the 10-26 PT week is filled once below, the same week the Top Shot table was seeded with — PRE-11-04
-- prices, so it is the "before" row, never a calibration input (#234: "never calibrate on pre-11-04 weeks").
-- The 11-02 week fills on Monday 11-09 like Top Shot's.
--
-- No CREATE FUNCTION in this file, so no anon-exec marker is owed. refresh_fmv_accuracy_weekly stays revoked from
-- PUBLIC/anon/authenticated (20261105040000); the job runs as postgres, like 828.
--
-- ⚠ NOT APPLIED when committed: this session could not apply production DDL. Apply with apply_migration (or the
-- dashboard SQL editor, then record the version row by hand). If the recorded version differs from this file's,
-- rename the file to the recorded version.
--
-- REVERT: SELECT cron.unschedule('rpc-fmv-accuracy-weekly-allday');
--         DELETE FROM public.fmv_accuracy_weekly WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.refresh_fmv_accuracy_weekly(uuid,date)')) THEN
    RAISE EXCEPTION 'refresh_fmv_accuracy_weekly(uuid,date) is missing; apply 20261105040000 first';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-fmv-accuracy-weekly-allday') THEN
    RAISE EXCEPTION 'rpc-fmv-accuracy-weekly-allday is already scheduled';
  END IF;
END
$guard$;

SELECT cron.schedule(
  'rpc-fmv-accuracy-weekly-allday',
  '45 11 * * 1',
  $cron$SELECT public.refresh_fmv_accuracy_weekly('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid,
          (date_trunc('week', (now() AT TIME ZONE 'America/Los_Angeles'))::date - 7))$cron$
);

-- Baseline week (PT Monday 10-26). Delete-then-insert inside the function, so re-running is idempotent.
SELECT public.refresh_fmv_accuracy_weekly('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, DATE '2026-10-26');
