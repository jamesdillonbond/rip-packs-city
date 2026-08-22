-- Refresh + telemetry for the newly materialized deals board.
--
-- ⚠ WHY THIS IS NOT A BARE `REFRESH` LIKE EVERY OTHER MV REFRESHER IN THIS SCHEMA.
-- Materialising the board created a failure mode the board did not previously have:
-- it can now be STALE. Before, `cross_collection_deals_board` was computed live, so
-- "the data is old" was not expressible. And the guard that watches this board —
-- public_board_liveness_watchlist, where it sits with min_rows=1, max_ms=15400 — checks
-- ROW COUNT and LATENCY. A frozen MV returns its last 172 rows in ~3ms and passes that
-- check perfectly. The instrument is structurally blind to the exact thing this change
-- introduced, which is the failure this repo keeps paying for.
--
-- So the refresh logs a pipeline_runs row, and the pipeline is registered in
-- pipeline_cadence_watchlist, making SILENCE the alarm — the one signal that survives
-- the whole function failing. A thrown REFRESH rolls back this transaction and takes
-- the log row with it (try/catch cannot rescue that), which is precisely why cadence,
-- not a self-reported error, is the instrument. cron.job_run_details holds the reason.
CREATE OR REPLACE FUNCTION public.refresh_cross_collection_deals()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_cross_collection_deals;
  SELECT count(*) INTO v_rows FROM public.mv_cross_collection_deals;
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'cross-collection-deals-mv',
    p_started_at   := v_started,
    p_rows_found   := v_rows,
    p_rows_written := v_rows,
    p_ok           := true,
    p_extra        := jsonb_build_object(
      'refresh_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'mv', 'mv_cross_collection_deals'
    )
  );
END;
$fn$;

-- Maintenance function: never anon/authenticated EXECUTE. A new/changed signature
-- lands with default PUBLIC EXECUTE, so revoke explicitly rather than assuming.
REVOKE EXECUTE ON FUNCTION public.refresh_cross_collection_deals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cross_collection_deals() TO postgres, service_role;
