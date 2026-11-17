-- audit_20261027 — three hourly Panini lanes had no pipeline_cadence_watchlist row, so a refresh that stopped
-- (or that logs ok=false and returns -1, which cron.job_run_details reads as "succeeded") was seen by nothing that
-- pages. Found by the review of the 10-25 commits. All three healthy at apply (last ok within the hour).
--   panini-league-coverage  pg_cron 27 * * * *  refresh_panini_league_coverage (team-hub panel; falls back to the live read after 26 h)
--   panini-product-rollup   pg_cron  6 * * * *  refresh_panini_product_rollup (/panini-blockchain/product/*)
--   panini-public-deals     pg_cron 44 * * * *  refresh_panini_public_deals (Panini leg of the Below FMV board)
-- Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('panini-league-coverage','panini-product-rollup','panini-public-deals');
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success) VALUES
  ('panini-league-coverage', 120, 'info', 'pg_cron 27 * * * * (hourly). refresh_panini_league_coverage — the team hubs'' Panini panel; after 26 h stale the panel falls back to the ~1 s live read. audit_20261027.', true, 180),
  ('panini-product-rollup', 120, 'info', 'pg_cron 6 * * * * (hourly). refresh_panini_product_rollup — /panini-blockchain/product/* pages read only the newest run. audit_20261027.', true, 180),
  ('panini-public-deals', 120, 'info', 'pg_cron 44 * * * * (hourly). refresh_panini_public_deals — the Panini leg of the Below FMV board; its stamp (readDealsAsOf) goes null when this stops. audit_20261027.', true, 180)
ON CONFLICT (pipeline) DO NOTHING;
