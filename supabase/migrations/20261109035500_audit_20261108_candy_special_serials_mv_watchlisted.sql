-- audit_20261108_candy_special_serials_mv_watchlisted
--
-- 2026-11-08 ~7:55 PM PT (Claude Code cloud). Companion to 20261109034500: the new
-- mv_candy_special_serials_board joins board_mv_refresh_watchlist at the same 6 h staleness its two
-- Candy siblings carry, so a refresh that stops (job 846) pages instead of serving a frozen board.
--
-- Revert: DELETE FROM public.board_mv_refresh_watchlist WHERE matview_name = 'mv_candy_special_serials_board';

INSERT INTO public.board_mv_refresh_watchlist (matview_name, max_stale_hours, is_active, note)
VALUES ('mv_candy_special_serials_board', 6, true,
        'backs the /insights/candy-mlb Special serials tab and the concierge special-serial tool (candy_special_serials_board wrapper); pg_cron rpc-refresh-candy-special-serials-board 12 * * * *')
ON CONFLICT (matview_name) DO NOTHING;
