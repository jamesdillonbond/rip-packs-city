-- The calibration rollup (pg_cron jobid 443, "7 * * * *", rollup_pipeline_gaps(3)) writes its own
-- terminal row as 'pipeline-gap-hourly-rollup'. A calibration series with a silent hole in it is
-- worse than none, so the rollup is watched from the start: 3x cadence silent, 6x without success.
-- Severity 'info': the CHECK allows critical | high | medium | info, and a stalled calibration
-- series is a note to the next session, not a page.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
VALUES (
  'pipeline-gap-hourly-rollup',
  180,
  360,
  'info',
  true,
  'Hourly calibration rollup for the correlated-skip arm (inbox 2026-09-03T0300Z): pg_cron jobid 443 at :07 calls rollup_pipeline_gaps(3), which re-aggregates the last 3 complete hours of pipeline_runs into pipeline_gap_hourly (idempotent). Nothing alerts on the table yet; this row only says the rollup itself keeps running. Added 2026-09-04.'
)
ON CONFLICT (pipeline) DO UPDATE SET
  max_silent_minutes = EXCLUDED.max_silent_minutes,
  max_minutes_without_success = EXCLUDED.max_minutes_without_success,
  severity = EXCLUDED.severity,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes;