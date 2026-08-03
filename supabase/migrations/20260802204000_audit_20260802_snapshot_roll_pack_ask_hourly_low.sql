-- Snapshot migration: public.roll_pack_ask_hourly_low().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- The hourly pack-ask-low ratchet: for each LISTED pack with a positive lowest
-- ask, it records the hour's lowest ask (ON CONFLICT keeps the LEAST, so within
-- an hour the value only ratchets DOWN), prunes buckets older than 7 days, and
-- writes each pack's rolling 24h / 7d minimum ask back onto pack_ask_state. The
-- monitoring log is best-effort (a failing log must never fail the roll). This
-- feeds the pack deal/discount surfaces, so a regression mis-prices every pack.
--
-- Pinned by supabase/tests/roll_pack_ask_hourly_low.sql.

CREATE OR REPLACE FUNCTION public.roll_pack_ask_hourly_low()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_bucket  timestamptz := date_trunc('hour', now());
  v_rolled  int := 0;
  v_pruned  int := 0;
BEGIN
  INSERT INTO public.pack_ask_hourly_low (collection_slug, dist_id, hour_bucket, low_ask)
  SELECT s.collection_slug, s.dist_id, v_bucket, s.lowest_ask
  FROM public.pack_ask_state s
  WHERE s.is_listed = true AND s.lowest_ask > 0
  ON CONFLICT (collection_slug, dist_id, hour_bucket)
  DO UPDATE SET low_ask = LEAST(public.pack_ask_hourly_low.low_ask, EXCLUDED.low_ask);
  GET DIAGNOSTICS v_rolled = ROW_COUNT;

  DELETE FROM public.pack_ask_hourly_low WHERE hour_bucket < now() - interval '7 days';
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  UPDATE public.pack_ask_state s
  SET low_ask_24h = agg.lo_24h,
      low_ask_7d  = agg.lo_7d
  FROM (
    SELECT collection_slug, dist_id,
           min(low_ask) FILTER (WHERE hour_bucket >= now() - interval '24 hours') AS lo_24h,
           min(low_ask) AS lo_7d
    FROM public.pack_ask_hourly_low
    GROUP BY collection_slug, dist_id
  ) agg
  WHERE agg.collection_slug = s.collection_slug AND agg.dist_id = s.dist_id;

  BEGIN
    PERFORM public.log_pipeline_run(
      p_pipeline   => 'pack-ask-hourly-low-roll',
      p_started_at => v_started,
      p_rows_found => v_rolled,
      p_rows_written => v_rolled,
      p_rows_skipped => v_pruned,
      p_ok         => true,
      p_extra      => jsonb_build_object('bucket', v_bucket, 'pruned', v_pruned)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- monitoring log is best-effort; never fail the roll
  END;

  RETURN jsonb_build_object('bucket', v_bucket, 'rolled', v_rolled, 'pruned', v_pruned, 'at', now());
END;
$function$;
