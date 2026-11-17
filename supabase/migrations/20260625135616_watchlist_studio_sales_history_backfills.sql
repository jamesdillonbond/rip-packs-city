-- Watchlist the 3 studio-platform sales-history drains (gate met: 4 clean 3h ticks
-- each). 600 min silence / medium severity = ~3 missed ticks + grace, so
-- detect_stalled_pipelines() catches a dead studio cron without false-positiving on
-- the every-3h cadence. (UFC studio drain — hourly+, single global cursor — is
-- watchlisted separately once it has banked cadence.)
-- Applied live 2026-06-25 (audit_20260625_watchlist_studio_sales_history_backfills);
-- this is the repo-parity copy.
-- Revert: DELETE FROM public.pipeline_cadence_watchlist
--           WHERE pipeline LIKE '%-studio-sales-history-backfill';
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, is_active)
VALUES
  ('allday-studio-sales-history-backfill', 600, 'medium', true),
  ('golazos-studio-sales-history-backfill', 600, 'medium', true),
  ('pinnacle-studio-sales-history-backfill', 600, 'medium', true)
ON CONFLICT (pipeline) DO UPDATE
  SET max_silent_minutes = EXCLUDED.max_silent_minutes,
      severity = EXCLUDED.severity,
      is_active = EXCLUDED.is_active;
