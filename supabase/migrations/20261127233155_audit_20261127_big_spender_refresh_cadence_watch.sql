-- Big-spender watch: cadence watch on its refresh (2026-11-27). refresh_big_spender_wallets() logs to
-- pipeline_runs only on success, so a failed or unscheduled run reads as silence; this arms the
-- standing cadence check on it.
-- The schedule itself was created with cron.schedule (not in a migration):
--   select cron.schedule('rpc-big-spender-refresh', '23 1,7,13,19 * * *', $$select public.refresh_big_spender_wallets(45)$$);  -- jobid 953
-- Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'big_spender_refresh';
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
VALUES ('big_spender_refresh', 720, 1440, 'info',
        'pg_cron 953 rpc-big-spender-refresh (23 1,7,13,19 * * * UTC, every 6 h). refresh_big_spender_wallets(45) — internal big-spender intel (big_spender_wallets / big_spender_top_sales). Logs only on success, so a failed run reads as silence. audit_20261127.')
ON CONFLICT (pipeline) DO NOTHING;
