-- Add a cleanup step to promote_unmapped_sales: at the end of each
-- invocation, delete unmapped_sales rows whose resolved_at is older than
-- 7 days. The promoted row already lives in the canonical sales table
-- (sales_2026), so the staging row past its 7-day debugging window is
-- pure bloat. Keeping a 7-day window preserves a debug breadcrumb for any
-- recently-promoted row that was misclassified and needs to be re-mapped.
-- Returns the deletion count alongside the existing promoted/unresolved
-- fields in the function's jsonb result so cron observers can track
-- archive volume per run.

CREATE OR REPLACE FUNCTION public.promote_unmapped_sales(
  p_collection_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_promoted     integer := 0;
  v_still_unres  integer := 0;
  v_archived     integer := 0;
  v_fmv_result   jsonb;
  v_run          jsonb;
  v_started_at   timestamptz := clock_timestamp();
BEGIN
  WITH resolved AS (
    SELECT DISTINCT ON (us.id)
           us.id AS unmapped_id,
           COALESCE(e1.id, e2.id, e3.id) AS edition_id,
           nem.serial_number AS map_serial
    FROM public.unmapped_sales us
    LEFT JOIN public.editions e1 ON e1.collection_id = us.collection_id
      AND us.resolution_hint ? 'set_id_onchain' AND us.resolution_hint ? 'play_id_onchain'
      AND e1.external_id = (us.resolution_hint->>'set_id_onchain') || ':' || (us.resolution_hint->>'play_id_onchain')
    LEFT JOIN public.editions e2 ON e2.collection_id = us.collection_id
      AND us.resolution_hint ? 'edition_id'
      AND e2.external_id = us.resolution_hint->>'edition_id'
    LEFT JOIN public.nft_edition_map nem ON nem.collection_id = us.collection_id
      AND nem.nft_id = us.nft_id
    LEFT JOIN public.editions e3 ON e3.collection_id = us.collection_id
      AND e3.external_id = nem.edition_external_id
    WHERE us.resolved_at IS NULL
      AND COALESCE(e1.id, e2.id, e3.id) IS NOT NULL
      AND (p_collection_id IS NULL OR us.collection_id = p_collection_id)
    LIMIT p_limit
  ),
  inserted AS (
    INSERT INTO public.sales (
      moment_id, edition_id, collection_id, serial_number,
      price_usd, price_native, currency,
      seller_address, buyer_address, marketplace,
      transaction_hash, block_height, sold_at, nft_id, collection, source
    )
    SELECT
      NULL, r.edition_id, us.collection_id,
      COALESCE(us.serial_number, r.map_serial, 0),
      us.price_usd, us.price_native, COALESCE(us.currency, 'USD'),
      us.seller_address, us.buyer_address, us.marketplace,
      us.transaction_hash, us.block_height, us.sold_at, us.nft_id,
      (SELECT slug FROM public.collections WHERE id = us.collection_id),
      COALESCE(us.source, 'promoted_from_unmapped')
    FROM public.unmapped_sales us
    JOIN resolved r ON r.unmapped_id = us.id
    ON CONFLICT DO NOTHING
    RETURNING id
  ),
  mark_resolved AS (
    UPDATE public.unmapped_sales us
    SET resolved_at = now()
    FROM resolved r
    WHERE us.id = r.unmapped_id
      AND EXISTS (SELECT 1 FROM inserted)
    RETURNING us.id
  )
  SELECT count(*) INTO v_promoted FROM mark_resolved;

  SELECT count(*) INTO v_still_unres
  FROM public.unmapped_sales
  WHERE resolved_at IS NULL
    AND (p_collection_id IS NULL OR collection_id = p_collection_id);

  -- Auto-refresh sales-based FMV when we promoted any sales
  IF v_promoted > 0 AND p_collection_id IS NOT NULL THEN
    SELECT public.fmv_from_sales(p_collection_id) INTO v_fmv_result;
  END IF;

  -- Archive: delete resolved staging rows older than 7 days. The canonical
  -- sale already lives in public.sales (or a sales_YYYY partition). We keep
  -- a 7-day window of resolved rows for debugging recently-promoted sales.
  -- Runs unconditionally per invocation so the staging table doesn't
  -- accumulate even when no new promotions happen this tick.
  WITH del AS (
    DELETE FROM public.unmapped_sales
    WHERE resolved_at IS NOT NULL
      AND resolved_at < now() - interval '7 days'
      AND (p_collection_id IS NULL OR collection_id = p_collection_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_archived FROM del;

  v_run := jsonb_build_object(
    'promoted', v_promoted,
    'still_unresolved', v_still_unres,
    'archived', v_archived,
    'fmv_refresh', COALESCE(v_fmv_result, 'null'::jsonb),
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started_at))::integer
  );

  PERFORM public.log_pipeline_run(
    'promote_unmapped_sales', v_started_at,
    p_rows_written := v_promoted,
    p_collection_slug := (SELECT slug FROM public.collections WHERE id = p_collection_id),
    p_extra := v_run
  );

  RETURN v_run;
END;
$function$;
