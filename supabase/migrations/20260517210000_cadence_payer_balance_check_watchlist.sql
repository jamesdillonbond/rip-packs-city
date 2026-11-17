-- Watchlist entry for the new Cadence payer balance health check.
-- Routes: /api/cron/cadence-payer-balance-check (POST/GET, Bearer auth).
-- Schedule cron-job.org every 30min. Watches 0x73f55c4450b8d466 — the
-- service payer that's been draining and producing 649
-- INSUFFICIENT_GAS_FUNDS downstream errors in production logs as of
-- 2026-05-17.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'cadence-payer-balance-check',
  60,
  'high',
  'Health check for the Cadence service payer wallet 0x73f55c4450b8d466. Schedule cron-job.org every 30min. ok=false fires when balance < 0.05 FLOW. 2026-05-17: 649 INSUFFICIENT_GAS_FUNDS errors traced to this payer being drained; this check surfaces the depletion at the source rather than downstream where every signing pipeline produces a follow-on error. Top up via flow CLI or directly to 0x73f55c4450b8d466.',
  true
)
ON CONFLICT (pipeline) DO UPDATE
  SET max_silent_minutes = EXCLUDED.max_silent_minutes,
      severity = EXCLUDED.severity,
      notes = EXCLUDED.notes,
      is_active = EXCLUDED.is_active;
