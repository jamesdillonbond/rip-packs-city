-- ⚠ Materialising a live-computed board CREATES a staleness failure it did not have.
-- panini_squeeze_board sits in public_board_liveness_watchlist with min_rows=1023,
-- max_ms=3000 — a FROZEN MV returns its last 4,680 rows in milliseconds and passes both
-- for ever. So the refresh logs a pipeline_runs row and is registered in
-- pipeline_cadence_watchlist: SILENCE is the alarm. Cadence rather than a self-reported
-- error, because a thrown REFRESH rolls back this transaction and takes the log row with it.
CREATE OR REPLACE FUNCTION public.refresh_panini_squeeze()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_squeeze;
  SELECT count(*) INTO v_rows FROM public.mv_panini_squeeze;
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'panini-squeeze-mv',
    p_started_at   := v_started,
    p_rows_found   := v_rows,
    p_rows_written := v_rows,
    p_ok           := true,
    p_extra        := jsonb_build_object(
      'refresh_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'mv', 'mv_panini_squeeze'));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_squeeze() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_squeeze() TO postgres, service_role;
