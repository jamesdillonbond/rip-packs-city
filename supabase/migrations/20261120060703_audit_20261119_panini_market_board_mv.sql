-- audit_20261119_panini_market_board_mv — the Panini Market tab reads a stored copy of the board.
--
-- WHY: `panini_market_board` (20260926041904) aggregates every listed serial on each read. Measured
-- 2026-11-19 ~9:40 PM PT: warm 787 ms / 501k buffers; pg_stat_statements for the board read 5,595
-- calls, mean 1.57 s, worst 29.9 s; 5 of 9 uncached requests to /api/market for Panini 503'd at the
-- 8 s bound (register R152). The CDN window shipped the same evening (ca49163) covers repeat URLs
-- only; every uncached sort / filter variant still paid the aggregate.
--
-- WHAT: mv_panini_market_board = the view's rows + computed_at, refreshed every 15 min by pg_cron
-- (`rpc-panini-market-board`, one board computation per tick). /api/market's Panini arm reads it and
-- falls back to the live view when the copy is unreadable or older than 2 h, so a stalled refresher
-- costs speed, never truth. The live view is unchanged and still serves the keyed readers
-- (edition page ask, concierge).
--
-- Revert: point fetchPaniniMarketListings back at panini_market_board (git revert the code commit);
--         SELECT cron.unschedule('rpc-panini-market-board'); DROP FUNCTION public.refresh_panini_market_board();
--         DROP MATERIALIZED VIEW public.mv_panini_market_board;
--
-- anon-exec: revoked (refresh_panini_market_board) — new SECURITY DEFINER refresher; REVOKE FROM PUBLIC, anon, authenticated below.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_market_board AS
SELECT b.edition_id, b.external_id, b.player_name, b.set_name, b.tier, b.circulation_count,
       b.thumbnail_url, b.parallel_family, b.low_ask_usd, b.listed_count, b.ask_confirmed_at,
       b.fmv_usd, b.confidence, b.fmv_computed_at, b.discount_pct,
       now() AS computed_at
  FROM public.panini_market_board b
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_panini_market_board_pk ON public.mv_panini_market_board (external_id);
CREATE INDEX IF NOT EXISTS mv_panini_market_board_low_ask ON public.mv_panini_market_board (low_ask_usd, external_id);

REVOKE ALL ON public.mv_panini_market_board FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_market_board TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_panini_market_board IS
  'Stored copy of panini_market_board (audit_20261119) + computed_at, refreshed every 15 min by pg_cron rpc-panini-market-board. Read by /api/market (Panini arm), which falls back to the live view when computed_at is older than 2 h. service_role only.';

CREATE OR REPLACE FUNCTION public.refresh_panini_market_board()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_market_board;
  SELECT count(*) INTO v_rows FROM public.mv_panini_market_board;
  PERFORM public.log_pipeline_run('panini-market-board', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261119'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-market-board', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261119', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_market_board() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_market_board() TO postgres, service_role;

REFRESH MATERIALIZED VIEW public.mv_panini_market_board;

SELECT cron.schedule('rpc-panini-market-board', '7,22,37,52 * * * *', $$SELECT public.refresh_panini_market_board()$$);
