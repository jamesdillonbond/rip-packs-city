-- ⚠ Both first-mint views sit in public_board_liveness_watchlist (trophies min_rows=165,
-- stats min_rows=1) which check ROW COUNT and LATENCY — a frozen MV returns its last 697
-- rows in milliseconds and passes both for ever. pipeline_cadence_watchlist makes SILENCE
-- the alarm instead.
CREATE OR REPLACE FUNCTION public.refresh_topshot_first_mint_trophies()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_first_mint_trophies;
  SELECT count(*) INTO v_rows FROM public.mv_topshot_first_mint_trophies;
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'topshot-first-mint-mv',
    p_started_at   := v_started,
    p_rows_found   := v_rows,
    p_rows_written := v_rows,
    p_ok           := true,
    p_extra        := jsonb_build_object(
      'refresh_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'mv', 'mv_topshot_first_mint_trophies'));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.refresh_topshot_first_mint_trophies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_first_mint_trophies() TO postgres, service_role;
