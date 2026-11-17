-- pipeline_runs.duration_ms is a GENERATED column; writing it errors 428C9 and
-- rolls back the whole refresh. Drop it from the insert and let it derive.
CREATE OR REPLACE FUNCTION public.refresh_series_stats_rollup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pinnacle CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_started  timestamptz := clock_timestamp();
  v_rows     int;
  v_deleted  int;
BEGIN
  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (s.edition_id) s.edition_id, s.fmv_usd, s.floor_price_usd
    FROM fmv_snapshots s
    ORDER BY s.edition_id, s.computed_at DESC
  ),
  agg AS (
    SELECT e.collection_id,
           e.series AS series_number,
           count(*)::int AS edition_count,
           sum(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL) AS total_circulation,
           sum(l.fmv_usd) FILTER (WHERE l.fmv_usd > 0) AS fmv_total_usd,
           sum(COALESCE(l.floor_price_usd, l.fmv_usd)) FILTER (WHERE COALESCE(l.floor_price_usd, l.fmv_usd) > 0) AS floor_total_usd,
           count(DISTINCT e.set_name)::int AS set_count,
           count(DISTINCT COALESCE(e.player_id::text, e.player_name))::int AS player_count
    FROM editions e
    LEFT JOIN latest l ON l.edition_id = e.id
    WHERE e.series IS NOT NULL
    GROUP BY 1, 2
  )
  INSERT INTO series_stats_rollup AS r
    (collection_id, series_number, edition_count, total_circulation,
     fmv_total_usd, floor_total_usd, set_count, player_count, refreshed_at)
  SELECT cs.collection_id,
         cs.series_number,
         COALESCE(a.edition_count, 0),
         a.total_circulation,
         a.fmv_total_usd,
         a.floor_total_usd,
         COALESCE(a.set_count, 0),
         COALESCE(a.player_count, 0),
         now()
  FROM collection_series cs
  LEFT JOIN agg a
    ON a.collection_id = cs.collection_id
   AND a.series_number = cs.series_number
  WHERE cs.collection_id <> v_pinnacle
  ON CONFLICT (collection_id, series_number) DO UPDATE SET
    edition_count     = EXCLUDED.edition_count,
    total_circulation = EXCLUDED.total_circulation,
    fmv_total_usd     = EXCLUDED.fmv_total_usd,
    floor_total_usd   = EXCLUDED.floor_total_usd,
    set_count         = EXCLUDED.set_count,
    player_count      = EXCLUDED.player_count,
    refreshed_at      = EXCLUDED.refreshed_at;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  DELETE FROM series_stats_rollup r
  WHERE NOT EXISTS (
    SELECT 1 FROM collection_series cs
    WHERE cs.collection_id = r.collection_id
      AND cs.series_number = r.series_number
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO pipeline_runs (pipeline, started_at, finished_at, rows_written, rows_skipped, ok, extra)
  VALUES ('refresh-series-stats-rollup', v_started, clock_timestamp(),
          v_rows, v_deleted, true,
          jsonb_build_object('upserted', v_rows, 'pruned', v_deleted));

  RETURN jsonb_build_object('upserted', v_rows, 'pruned', v_deleted,
                            'duration_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_series_stats_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_series_stats_rollup() TO postgres, service_role;