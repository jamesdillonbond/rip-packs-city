-- audit_20260830_grail_mv_cadence_arm_tolerates_one_lost_tick_90_to_130
--
-- Raises pipeline_cadence_watchlist.max_silent_minutes for
-- refresh-pack-grail-metrics-mv from 90 -> 130. Severity (info) and is_active
-- are UNCHANGED.
--
-- WHY: the refresh moved from a maxDuration-60 route to pg_cron jobid 384
-- (`23 * * * *`, hourly) on 2026-08-29 (migration 20260829235752). A 90-minute
-- arm on an HOURLY job tolerates ZERO lost ticks -- and the fleet loses ~3-4% of
-- ticks to `job startup timeout`, measured this morning over 51 days of
-- cron.job_run_details (3,034 events / 84 jobs, ~70% of ALL pg_cron failures).
-- One lost tick puts the gap at ~120 min while the matview is perfectly FRESH,
-- so the arm false-breaches by construction, roughly daily.
--
-- ⭐ THIS IS A DESIGN CHOICE, NOT A CURVE FIT: "tolerate exactly one lost tick".
-- 130 = 60 (cadence) + 60 (one lost tick) + 10 (margin). Two lost ticks (~180
-- min) still breach, so a genuine STOP is still caught -- ~40 min later than
-- before, which is the whole cost, on an `info` arm whose job is a ranking-UI
-- matview.
--
-- ⚠ THE SUPPORTING SAMPLE IS THIN AND DIRTY, AND IS NOT THE BASIS. Since the
-- move there are only 16 terminal rows over 15.4 h: median gap 60 min, p90 62,
-- **max 117** -- i.e. the false breach is already OBSERVED, but n=16 on a day
-- with two saturation bands (08:xx and 13:57-14:13Z). The daytime-monitor
-- filing that raised this asked for a clean 72 h window first; that window is
-- not satisfiable until ~2026-09-01 because the job is only 15 h old in this
-- form. ⭐ The dirty sample argues FOR the change rather than against it: a bad
-- day is exactly when an arm must not cry wolf, and 117 min is a LOWER bound on
-- what a bad day produces.
--
-- 👉 STILL OWED: the 72 h re-measure the filing asked for. It can only TIGHTEN
-- this back -- if a clean week shows max gap comfortably under 120, 130 is
-- generous and can come down. Do not read this migration as closing that.
--
-- ⛔ NOT the fix for the underlying loss: `job startup timeout` is a capacity
-- symptom on an IO-bound Small instance and its mechanism is UNESTABLISHED (the
-- obvious `cron.max_running_jobs=32` vs `max_worker_processes=6` reading was
-- measured and REFUTED -- observed concurrency reaches 11). This only stops the
-- arm reporting that loss as a stall.
--
-- REVERT:
--   UPDATE public.pipeline_cadence_watchlist w SET max_silent_minutes = b.max_silent_minutes
--     FROM public.audit_20260830_grail_arm_backup b WHERE w.pipeline = b.pipeline;
--   DROP TABLE public.audit_20260830_grail_arm_backup;
-- ⚠ Named explicitly -- other sessions write into the audit_20260830_ prefix.

CREATE TABLE IF NOT EXISTS public.audit_20260830_grail_arm_backup AS
SELECT pipeline, max_silent_minutes, severity, is_active
FROM public.pipeline_cadence_watchlist
WHERE pipeline = 'refresh-pack-grail-metrics-mv';

-- RLS on, no policies: service_role only -- the standing convention for audit_*
-- tables here, enforced by the smoke suite's "public base tables: RLS on" arm.
ALTER TABLE public.audit_20260830_grail_arm_backup ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.audit_20260830_grail_arm_backup IS
  'Revert copy of the refresh-pack-grail-metrics-mv cadence arm before widening 90->130 min on 2026-08-30. RLS on, no policies: service_role only. Safe to drop once accepted; do NOT wildcard-drop the audit_20260830_ prefix.';

UPDATE public.pipeline_cadence_watchlist
SET max_silent_minutes = 130,
    notes = notes || E'\n\n⏱ 2026-08-30 — max_silent_minutes 90 -> 130. A 90-min arm on this HOURLY pg_cron form (jobid 384, `23 * * * *`, moved 2026-08-29 by 20260829235752) tolerates ZERO lost ticks, and the fleet loses ~3-4% of ticks to `job startup timeout` (3,034 events / 84 jobs / 51 days, ~70% of all pg_cron failures) -- so one lost tick meant a ~120-min gap and an INFO breach while the matview was FRESH. 130 = 60 cadence + 60 one lost tick + 10 margin: a genuine STOP still breaches at ~180 min, just ~40 min later. ⭐ A DESIGN CHOICE (tolerate exactly one lost tick), NOT a fit to the sample: since the move there were only 16 terminal rows over 15.4 h (median 60, p90 62, max 117) on a day carrying two saturation bands. 👉 STILL OWED: the clean 72-h re-measure the 2026-08-30T1510Z daytime-monitor filing asked for -- unsatisfiable before ~2026-09-01 because the job is 15 h old in this form, and it can only TIGHTEN this back. ⛔ This does NOT fix the tick loss; that is a capacity symptom whose mechanism is unestablished (cron.max_running_jobs=32 vs max_worker_processes=6 was measured and REFUTED -- observed concurrency reaches 11).'
WHERE pipeline = 'refresh-pack-grail-metrics-mv';
