-- Why this exists (measured 2026-08-23).
--
-- get_series_detail aggregates FMV per series with one LEFT JOIN LATERAL over
-- fmv_snapshots PER EDITION. That is 3,600 random index probes for Top Shot
-- Series 4 and 4,895 for Series 7, on an IOPS-throttled instance:
--     54 editions   ->     10 ms
--    575 editions   ->  1,573 ms warm / 4,610 ms cold
--  3,600 editions   -> 21,229 ms warm / 43,750 ms cold   (23k buffers, 819-3,161 reads)
-- The function declares statement_timeout '8s', which BINDS on the PostgREST
-- rpc/ entry point, so production returns 57014 and every /[collection]/series/
-- [slug] page 500s. All 26 of them are in the sitemap.
--
-- Two rewrites were measured before choosing this one:
--   (a) prune the empty 2027 partition with `computed_at <= now()`
--       -> 23,328 -> 16,132 buffers (-31%). Real, but not enough.
--   (b) collection-scoped DISTINCT ON inside the page query
--       -> 3.8 s but 784,000 buffers, 34x the current traversal. This is the
--          known `fmv_current` trap: every page view pays for the whole
--          collection. REJECTED on buffers, not on wall clock.
--   (c) THIS: compute every series ONCE, set-based.
--       -> 1.86 s and 687 physical reads for ALL 23 populated series together,
--          i.e. a full rebuild costs less than one page view does today.
--
-- Freshness: the page already ships `export const revalidate = 600`, so a
-- rollup refreshed more often than 10 minutes is not a freshness regression.
--
-- REVERT: DROP FUNCTION public.refresh_series_stats_rollup();
--         DROP TABLE public.series_stats_rollup;
--         (get_series_detail is untouched by THIS migration.)

CREATE TABLE IF NOT EXISTS public.series_stats_rollup (
  collection_id     uuid        NOT NULL,
  series_number     integer     NOT NULL,
  edition_count     integer     NOT NULL DEFAULT 0,
  total_circulation bigint,
  fmv_total_usd     numeric,
  floor_total_usd   numeric,
  set_count         integer     NOT NULL DEFAULT 0,
  player_count      integer     NOT NULL DEFAULT 0,
  refreshed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, series_number)
);

ALTER TABLE public.series_stats_rollup ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated grants. The only reader is a SECURITY DEFINER function,
-- which does not need them, and a public table with no policy is a hole.
REVOKE ALL ON TABLE public.series_stats_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.series_stats_rollup TO service_role;

COMMENT ON TABLE public.series_stats_rollup IS
  'Per-(collection, series) aggregate behind get_series_detail. Refreshed by refresh_series_stats_rollup(). Pinnacle is NOT in here - its branch reads pinnacle_editions and already runs in ~60ms. A MISSING row means "not yet refreshed", never "zero editions": every series in collection_series gets a row, with zeros when empty, so get_series_detail can safely fall back to the live path only when a row is genuinely absent.';

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
    -- ONE ordered pass over the whole partition set, not one probe per edition.
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

  -- A series deleted from collection_series must not leave a stale rollup row
  -- that get_series_detail would happily keep serving.
  DELETE FROM series_stats_rollup r
  WHERE NOT EXISTS (
    SELECT 1 FROM collection_series cs
    WHERE cs.collection_id = r.collection_id
      AND cs.series_number = r.series_number
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO pipeline_runs (pipeline, started_at, finished_at, duration_ms, rows_written, rows_skipped, ok, extra)
  VALUES ('refresh-series-stats-rollup', v_started, clock_timestamp(),
          (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
          v_rows, v_deleted, true,
          jsonb_build_object('upserted', v_rows, 'pruned', v_deleted));

  RETURN jsonb_build_object('upserted', v_rows, 'pruned', v_deleted,
                            'duration_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_series_stats_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_series_stats_rollup() TO postgres, service_role;