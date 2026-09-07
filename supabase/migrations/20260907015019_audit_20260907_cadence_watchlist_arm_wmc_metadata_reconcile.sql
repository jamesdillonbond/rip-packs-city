-- audit_20260907: arm the cadence watchlist for wmc-metadata-reconcile.
-- The pipeline had NO watchlist row, so a wedge (cycles stop advancing while
-- pg_cron keeps ticking) or a stopped schedule was invisible — and the cadence
-- was just moved */10 → 15,45 in the previous migration, which is exactly when
-- a schedule typo would otherwise go unnoticed. 100 min = 3 missed 30-min ticks
-- + slack; no-success arm 200 min (2× silent), the 09-04 seeding convention.
-- REVERT: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'wmc-metadata-reconcile';
INSERT INTO public.pipeline_cadence_watchlist (pipeline, severity, is_active, max_silent_minutes, max_minutes_without_success, notes)
VALUES (
  'wmc-metadata-reconcile', 'medium', true, 100, 200,
  'pg_cron jobid 456 rpc-wmc-metadata-reconcile, every 30 min at :15/:45 since 2026-09-07 (was */10 from 2026-09-04; the drain converged 09-04 ~21:00Z and it was the #1 physical reader at 10-min cadence — inbox 2026-09-05T1630Z). 100 min = 3 missed ticks. Health is SILENCE, not rows_written: post-drain it writes 2–220 rows/hour by design.'
)
ON CONFLICT (pipeline) DO UPDATE SET severity = EXCLUDED.severity, is_active = true,
  max_silent_minutes = EXCLUDED.max_silent_minutes, max_minutes_without_success = EXCLUDED.max_minutes_without_success,
  notes = EXCLUDED.notes;
