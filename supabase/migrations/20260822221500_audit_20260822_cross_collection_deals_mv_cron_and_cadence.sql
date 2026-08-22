-- Non-DDL production state that shipped with the deals-board materialisation, recorded
-- here so the repo carries the revert path. These were applied via execute_sql (they
-- are DML against cron.job / a watchlist table, not schema DDL), so they do NOT appear
-- in supabase_migrations.schema_migrations — this file exists to keep them describable.
--
-- ⚠ WITHOUT THE CRON, THE MATERIALISATION IS A LIE: the board would serve whatever the
-- MV held at swap time, for ever, while every liveness check kept passing.
--
-- Cadence: every 20 min. Chosen from the measured read rate, not by feel — the view was
-- computed 984 times over 258h (3.81/h), so 3/h is ~21% fewer full computations AND
-- every read collapses from ~12,905 ms to ~3 ms. Faster cadences (15 min = 4/h) go
-- read-negative; slower ones (30 min) save more and cost freshness. One alter_job away.

SELECT cron.schedule(
  'rpc-refresh-cross-collection-deals',
  '12,32,52 * * * *',
  $$SET statement_timeout = '600s'; SELECT public.refresh_cross_collection_deals();$$
);

-- ⚠ The statement_timeout lives in the CRON COMMAND, not in the function's proconfig.
-- A function-level SET does not re-arm the already-armed top-level statement timer
-- (documented in this repo, and re-confirmed today: refresh_atlas_pack_ev declares
-- 120s and its failures still run to 615s).

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'cross-collection-deals-mv', 70, 'medium',
  'pg_cron rpc-refresh-cross-collection-deals, 12,32,52 = every 20 min. 70 min = ~3.5 missed ticks. THIS IS THE ONLY FRESHNESS INSTRUMENT FOR THAT BOARD: public_board_liveness_watchlist checks row count + latency, and a FROZEN MV passes both. Silence here is the alarm.',
  true
)
ON CONFLICT (pipeline) DO UPDATE SET max_silent_minutes = EXCLUDED.max_silent_minutes,
  severity = EXCLUDED.severity, notes = EXCLUDED.notes, is_active = true;

-- REVERT (full, in order):
--   SELECT cron.unschedule('rpc-refresh-cross-collection-deals');
--   UPDATE public.pipeline_cadence_watchlist SET is_active = false WHERE pipeline = 'cross-collection-deals-mv';
--   CREATE OR REPLACE VIEW public.cross_collection_deals_board WITH (security_invoker = on) AS
--     <the pre-materialisation 3-arm UNION ALL body, recoverable from this commit's parent>;
--   DROP MATERIALIZED VIEW public.mv_cross_collection_deals;
--   DROP FUNCTION public.refresh_cross_collection_deals();
