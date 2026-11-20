-- audit_20261119_panini_market_board_refresh_every_30_min — halve the refresh cadence.
--
-- The first scheduled tick of rpc-panini-market-board (jobid 896, 2026-11-19 10:22 PM PT) took
-- 21.9 s (REFRESH ... CONCURRENTLY on a cold cache; a warm manual call took 3.0 s). Panini asks are
-- confirmed by a walk that revisits an edition every few days and the board keeps an ask for 7 days,
-- so a 15-minute copy buys nothing a 30-minute one does not. /api/market still falls back to the
-- live view when the copy is older than 2 h (now four missed ticks).
--
-- Revert: SELECT cron.schedule('rpc-panini-market-board', '7,22,37,52 * * * *', $$SELECT public.refresh_panini_market_board()$$);

SELECT cron.schedule('rpc-panini-market-board', '7,37 * * * *', $$SELECT public.refresh_panini_market_board()$$);

COMMENT ON MATERIALIZED VIEW public.mv_panini_market_board IS
  'Stored copy of panini_market_board (audit_20261119) + computed_at, refreshed every 30 min by pg_cron rpc-panini-market-board. Read by /api/market (Panini arm), which falls back to the live view when computed_at is older than 2 h. service_role only.';
