-- Local mirror of the prune RPC + watchlist entry applied via Supabase
-- MCP on 2026-05-17. flowty_archive.api_harvest_20260512 was 9.35 GB
-- (85% of the rip-packs-city Supabase database) on 2026-05-17 and
-- growing at ~600 rows/hr (~50 MB/hr) without any consumer reading the
-- table. This RPC drains rows older than the retention threshold in
-- bounded batches so a single lock window doesn't hang the table.
CREATE OR REPLACE FUNCTION public.prune_flowty_archive_api_harvest(
  p_retention_days int DEFAULT 7,
  p_batch_size int DEFAULT 10000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_cutoff timestamptz;
  v_total_deleted int := 0;
  v_batch_deleted int := 0;
  v_batches int := 0;
  v_max_batches int := 20;
  v_oldest timestamptz;
  v_newest timestamptz;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 THEN
    p_retention_days := 7;
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN
    p_batch_size := 10000;
  END IF;

  v_cutoff := now() - (p_retention_days || ' days')::interval;

  LOOP
    EXIT WHEN v_batches >= v_max_batches;

    WITH victims AS (
      SELECT id
      FROM flowty_archive.api_harvest_20260512
      WHERE collected_at < v_cutoff
      ORDER BY collected_at
      LIMIT p_batch_size
    )
    DELETE FROM flowty_archive.api_harvest_20260512
    WHERE id IN (SELECT id FROM victims);
    GET DIAGNOSTICS v_batch_deleted = ROW_COUNT;

    v_total_deleted := v_total_deleted + v_batch_deleted;
    v_batches := v_batches + 1;

    EXIT WHEN v_batch_deleted < p_batch_size;
  END LOOP;

  SELECT MIN(collected_at), MAX(collected_at)
    INTO v_oldest, v_newest
    FROM flowty_archive.api_harvest_20260512;

  RETURN jsonb_build_object(
    'ok', true,
    'rows_deleted', v_total_deleted,
    'batches_run', v_batches,
    'retention_days', p_retention_days,
    'batch_size', p_batch_size,
    'cutoff', v_cutoff,
    'oldest_survivor', v_oldest,
    'newest_survivor', v_newest,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::int
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prune_flowty_archive_api_harvest(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_flowty_archive_api_harvest(int, int) FROM anon;
REVOKE ALL ON FUNCTION public.prune_flowty_archive_api_harvest(int, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prune_flowty_archive_api_harvest(int, int) TO postgres, service_role;


INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'prune-flowty-archive-api-harvest',
  180,
  'info',
  'Nightly retention prune for flowty_archive.api_harvest_20260512 (the May 12 firehose at 9.4 GB / 85% of DB on 2026-05-17). Schedule cron-job.org daily 04:15 UTC. Default 7-day retention, 10000-row batches, 20 batches/run cap. Companion filter on flowty_archive_insert_batch (drop high-volume endpoints firestore:STOREFRONT_OFFER_CREATED, firestore:STOREFRONT_OFFER_CANCELLED, collection:*:sale) is the steady-state fix; this prune handles the existing backlog.',
  true
)
ON CONFLICT (pipeline) DO UPDATE
  SET max_silent_minutes = EXCLUDED.max_silent_minutes,
      severity = EXCLUDED.severity,
      notes = EXCLUDED.notes,
      is_active = EXCLUDED.is_active;
