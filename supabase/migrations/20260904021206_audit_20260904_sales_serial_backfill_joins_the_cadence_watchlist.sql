-- sales-serial-backfill was on NO watchlist arm: it ran 12x/day with ok=true for a month while its
-- Top Shot lane failed 100% on a decommissioned host (3,071 rows in failure_reason='unknown',
-- 2026-08-06 -> 2026-09-04). Per-target failures are not pipeline failures by design (escrowed
-- moments are expected), so the silence and no-success arms are what this row buys: a stopped
-- Vercel cron (schedule "40 */2 * * *") or a sweep that stops completing. Sized from its own
-- history (36 runs, median gap 120 min, max 121): 3x cadence silent, 6x cadence without success.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
VALUES (
  'sales-serial-backfill',
  360,
  720,
  'medium',
  true,
  'Edge fn sales-serial-backfill (NULL-serial recovery: Top Shot + AllDay, both ON-CHAIN borrows via rest-mainnet since 2026-09-03), triggered by Vercel cron /api/cron/sales-serial-backfill at "40 */2 * * *" (the route logs as sales-serial-backfill-trigger). ok=true means the SWEEP completed; a lane that resolves nothing is only visible in extra.per_collection.<lane>.resolved and extra.failures_by_reason. Added 2026-09-04 after the Top Shot lane failed silently for a month.'
)
ON CONFLICT (pipeline) DO UPDATE SET
  max_silent_minutes = EXCLUDED.max_silent_minutes,
  max_minutes_without_success = EXCLUDED.max_minutes_without_success,
  severity = EXCLUDED.severity,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes;