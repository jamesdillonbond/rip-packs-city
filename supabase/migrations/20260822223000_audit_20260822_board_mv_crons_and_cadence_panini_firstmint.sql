-- Non-DDL production state shipped with the panini + first-mint materialisations, recorded
-- so the repo carries the revert path. Applied via execute_sql (DML against cron.job and a
-- watchlist table, not schema DDL), so they do NOT appear in schema_migrations.
--
-- ⚠ WITHOUT THESE CRONS THE MATERIALISATIONS ARE LIES: each board would serve whatever its
-- MV held at swap time, for ever, while every liveness check kept passing.
--
-- Cadence is 20 min for both, chosen from each board's OWN measured read rate:
--   panini      20.50 reads/h -> 3/h saves ~85%
--   first-mint   6.08 reads/h -> 3/h saves ~51%
-- (deals, shipped earlier, is 3.84/h -> 3/h saves ~22%; a 15-min refresh there would have
-- been read-NEGATIVE.) Materialising only wins BELOW the current read rate.

SELECT cron.schedule('rpc-refresh-panini-squeeze', '18,38,58 * * * *',
  $$SET statement_timeout = '600s'; SELECT public.refresh_panini_squeeze();$$);

SELECT cron.schedule('rpc-refresh-topshot-first-mint', '21,41,1 * * * *',
  $$SET statement_timeout = '600s'; SELECT public.refresh_topshot_first_mint_trophies();$$);

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES
 ('panini-squeeze-mv', 70, 'medium', 'pg_cron rpc-refresh-panini-squeeze, 18,38,58 = every 20 min. ONLY freshness instrument for panini_squeeze_board: public_board_liveness_watchlist checks row count + latency and a FROZEN MV passes both. Silence is the alarm.', true),
 ('topshot-first-mint-mv', 70, 'medium', 'pg_cron rpc-refresh-topshot-first-mint, 1,21,41 = every 20 min. Backs BOTH topshot_first_mint_trophies and topshot_first_mint_trophy_stats (the latter reads the former). Same blindness in the liveness watch; silence is the alarm.', true)
ON CONFLICT (pipeline) DO UPDATE SET max_silent_minutes=EXCLUDED.max_silent_minutes,
  severity=EXCLUDED.severity, notes=EXCLUDED.notes, is_active=true;

-- REVERT (per board, in order):
--   SELECT cron.unschedule('rpc-refresh-panini-squeeze');           -- / rpc-refresh-topshot-first-mint
--   UPDATE public.pipeline_cadence_watchlist SET is_active=false WHERE pipeline='panini-squeeze-mv';
--   CREATE OR REPLACE VIEW <board> WITH (security_invoker = on) AS <pre-materialisation body,
--     recoverable from this commit's parent via pg_get_viewdef history or the prior migration>;
--   DROP MATERIALIZED VIEW public.mv_panini_squeeze;                -- / mv_topshot_first_mint_trophies
--   DROP FUNCTION public.refresh_panini_squeeze();                  -- / refresh_topshot_first_mint_trophies()
