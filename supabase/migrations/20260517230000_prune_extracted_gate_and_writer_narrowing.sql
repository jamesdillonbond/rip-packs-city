-- Reversal of the original prune semantics. 2026-05-17 audit showed
-- the Flowty harvester walks backwards (each new day of collection
-- contains older events), so deleting by collected_at alone would
-- destroy the May 2026 purchase events the silent primary scanners
-- missed. Gating on extracted_at ensures we only drop rows whose
-- events have already landed in unmapped_sales / marketplace_offers.
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
  v_unextracted int;
  v_extracted_safe int;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 THEN
    p_retention_days := 7;
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN
    p_batch_size := 10000;
  END IF;

  v_cutoff := now() - (p_retention_days || ' days')::interval;

  SELECT COUNT(*) FILTER (WHERE extracted_at IS NULL),
         COUNT(*) FILTER (WHERE extracted_at IS NOT NULL AND extracted_at < v_cutoff)
    INTO v_unextracted, v_extracted_safe
    FROM flowty_archive.api_harvest_20260512;

  LOOP
    EXIT WHEN v_batches >= v_max_batches;

    WITH victims AS (
      SELECT id
      FROM flowty_archive.api_harvest_20260512
      WHERE extracted_at IS NOT NULL
        AND extracted_at < v_cutoff
      ORDER BY extracted_at
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
    'unextracted_remaining', v_unextracted,
    'extracted_eligible_at_start', v_extracted_safe,
    'oldest_survivor', v_oldest,
    'newest_survivor', v_newest,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::int
  );
END;
$function$;


-- Narrow flowty_archive_insert_batch — drop collection:*:sale and nft:*
-- endpoints. They overlap with public.sales / pinnacle_sales /
-- cached_listings_v2 and have no consumer. Cuts ongoing writer pressure
-- from ~1.2 GB/day to ~0.5 GB/day.
CREATE OR REPLACE FUNCTION public.flowty_archive_insert_batch(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO flowty_archive.api_harvest_20260512
    (endpoint, query_params, response_payload, response_status, collection_hint)
  SELECT
    (r->>'endpoint')::text,
    NULLIF(r->'query_params', 'null'::jsonb),
    COALESCE(r->'response_payload', 'null'::jsonb),
    NULLIF((r->>'response_status')::text, '')::int,
    NULLIF(r->>'collection_hint', '')::text
  FROM jsonb_array_elements(p_rows) AS r
  WHERE
    (r->>'endpoint')::text IN (
      'firestore:STOREFRONT_PURCHASED',
      'firestore:STOREFRONT_OFFER_CREATED',
      'firestore:STOREFRONT_OFFER_CANCELLED',
      'firestore:FUNDING_AVAILABLE',
      'firestore:FUNDING_REPAID',
      'firestore:FUNDING_SETTLED',
      'firestore:BID_CREATED',
      'firestore:BID_CANCELLED',
      'firestore:FUNDING_CANCELLED'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;


INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES
  ('extract-flowty-purchases',
    180, 'info',
    'Drains firestore:STOREFRONT_PURCHASED events from flowty_archive.api_harvest_20260512 into unmapped_sales. Schedule cron-job.org hourly at :09. Batch size 5000. Existing promote_unmapped_sales pipeline resolves edition_id and moves rows to public.sales when wmc/editions catch up. [INSTRUMENTATION_PENDING 2026-05-17 — review after first natural run.]',
    true),
  ('extract-flowty-offers',
    180, 'info',
    'Drains firestore:STOREFRONT_OFFER_CREATED + STOREFRONT_OFFER_CANCELLED events into marketplace_offers (partitioned by event_timestamp). Schedule cron-job.org hourly at :39. Batch size 5000. [INSTRUMENTATION_PENDING 2026-05-17 — review after first natural run.]',
    true)
ON CONFLICT (pipeline) DO UPDATE
  SET max_silent_minutes = EXCLUDED.max_silent_minutes,
      severity = EXCLUDED.severity,
      notes = EXCLUDED.notes,
      is_active = EXCLUDED.is_active;
