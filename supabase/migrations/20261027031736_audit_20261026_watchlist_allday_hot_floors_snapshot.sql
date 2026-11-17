-- audit_20261026: cadence watch for the All Day Hot Floors snapshot lane (pg_cron 802, every 15 min).
-- Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-hot-floors-snapshot';
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('allday-hot-floors-snapshot', 60, 'info',
  'pg_cron 8,23,38,53 (15 min). Precomputes /nfl-all-day/hot-floors (get_allday_hot_floors(7)). A stall leaves the page showing an older board with its own "updated N ago". audit_20261026.', 90)
ON CONFLICT DO NOTHING;
