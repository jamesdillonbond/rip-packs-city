-- 2026-11-14 (Claude Code cloud, ~1:40 PM PT) — fresh-eyes review of the /insights boards.
--
-- /insights/serial-premiums, headline "perfect mint" (Top Shot), reads topshot_perfect_mint_premiums_board
-- → mv_topshot_perfect_mint_premiums_board, refreshed by pg_cron `rpc-refresh-perfect-mint-premiums`
-- (every 2 h) as a bare `REFRESH MATERIALIZED VIEW CONCURRENTLY` that logs nothing. The board's
-- "Updated" stamp was the API's request time, so a dead refresh still read "Updated just now" over
-- data hours or days old (lib/insights/mv-freshness.ts: dishonest for an MV). This gives the refresh
-- a pipeline_runs row ('topshot-perfect-mint-premiums-mv') the route can date the rows by, and a
-- cadence watch so SILENCE alarms. Same shape as refresh_topshot_first_mint_trophies (20260822222607).
-- A failed REFRESH raises before the log, so a failing lane shows as silence (watched below).
--
-- anon-exec: revoked (refresh_topshot_perfect_mint_premiums_board) — new pg_cron-only function; EXECUTE for postgres, service_role.
--
-- Revert:
--   SELECT cron.alter_job(jobid, command := 'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_perfect_mint_premiums_board')
--     FROM cron.job WHERE jobname = 'rpc-refresh-perfect-mint-premiums';
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-perfect-mint-premiums-mv';
--   DROP FUNCTION public.refresh_topshot_perfect_mint_premiums_board();
CREATE OR REPLACE FUNCTION public.refresh_topshot_perfect_mint_premiums_board()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_perfect_mint_premiums_board;
  SELECT count(*) INTO v_rows FROM public.mv_topshot_perfect_mint_premiums_board;
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'topshot-perfect-mint-premiums-mv',
    p_started_at   := v_started,
    p_rows_found   := v_rows,
    p_rows_written := v_rows,
    p_ok           := true,
    p_extra        := jsonb_build_object(
      'refresh_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'mv', 'mv_topshot_perfect_mint_premiums_board'));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.refresh_topshot_perfect_mint_premiums_board() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_perfect_mint_premiums_board() TO postgres, service_role;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'rpc-refresh-perfect-mint-premiums';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly one rpc-refresh-perfect-mint-premiums job, found %', v_n; END IF;
  PERFORM cron.alter_job(jobid, command := 'SELECT public.refresh_topshot_perfect_mint_premiums_board()')
     FROM cron.job WHERE jobname = 'rpc-refresh-perfect-mint-premiums';
END $$;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
VALUES ('topshot-perfect-mint-premiums-mv', 300, 600, 'medium',
        'pg_cron rpc-refresh-perfect-mint-premiums, every 2 h (0 */2). Refreshes mv_topshot_perfect_mint_premiums_board behind /insights/serial-premiums (perfect-mint headline), whose "Updated" stamp now reads this row. 300 min = 2.5 missed ticks; no-success 600. Added 2026-11-14.',
        true)
ON CONFLICT (pipeline) DO NOTHING;
