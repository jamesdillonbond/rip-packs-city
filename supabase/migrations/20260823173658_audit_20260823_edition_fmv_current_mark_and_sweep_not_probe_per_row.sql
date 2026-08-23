-- First run of refresh_edition_fmv_current() blew past the MCP's 60 s tool cap
-- and rolled back with 0 rows written. The upsert is not the problem — the
-- orphan sweep was:
--
--   DELETE FROM edition_fmv_current t
--   WHERE NOT EXISTS (SELECT 1 FROM fmv_snapshots s WHERE s.edition_id = t.edition_id);
--
-- That is 27,075 random index probes into a 1.2M-row partitioned table — the
-- EXACT access pattern this whole table exists to eliminate. I wrote the shape I
-- was replacing, in the function replacing it.
--
-- Replaced with mark-and-sweep on the run stamp: every upserted row carries this
-- run's refreshed_at, so anything left behind is an orphan and one seq scan of a
-- ~27k-row table finds it. No probes.
--
-- REVERT: previous definition (NOT EXISTS sweep) — but do not, it does not
-- finish.
CREATE OR REPLACE FUNCTION public.refresh_edition_fmv_current()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_stamp   timestamptz := now();
  v_rows    int;
  v_pruned  int;
BEGIN
  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (s.edition_id)
           s.edition_id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
    FROM fmv_snapshots s
    ORDER BY s.edition_id, s.computed_at DESC
  )
  INSERT INTO edition_fmv_current AS t
    (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
  SELECT l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, v_stamp
  FROM latest l
  ON CONFLICT (edition_id) DO UPDATE SET
    collection_id   = EXCLUDED.collection_id,
    fmv_usd         = EXCLUDED.fmv_usd,
    floor_price_usd = EXCLUDED.floor_price_usd,
    confidence      = EXCLUDED.confidence,
    computed_at     = EXCLUDED.computed_at,
    refreshed_at    = EXCLUDED.refreshed_at;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Mark and sweep: anything this run did not touch no longer has a snapshot.
  DELETE FROM edition_fmv_current WHERE refreshed_at < v_stamp;
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN jsonb_build_object(
    'upserted', v_rows,
    'pruned', v_pruned,
    'duration_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_edition_fmv_current() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_edition_fmv_current() TO postgres, service_role, cron_heavy;