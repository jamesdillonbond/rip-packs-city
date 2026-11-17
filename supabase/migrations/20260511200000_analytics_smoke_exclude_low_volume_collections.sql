-- Generalize sales-freshness exclusion in analytics_smoke_run().
--
-- Previously the (2.1) freshness_sales_per_collection check hardcoded a
-- single exclusion for 'ufc_strike' via the detail key stale_count_excl_ufc.
-- Golazos has the same near-zero-volume profile (verified 2026-05-11:
-- 3267 min stale vs 1440 threshold) and was producing false-fail Telegram
-- alerts on the 13,43 * * * * cron tick.
--
-- New shape:
--   - PL/pgSQL local array v_low_volume_collections = ['ufc_strike',
--     'laliga_golazos'] gates the FILTER.
--   - detail key renamed stale_count_excl_ufc → stale_count_excl_low_volume.
--   - detail.low_volume_excluded surfaces the active exclusion list for
--     transparency in the smoke envelope.
--
-- Adding a future low-volume collection is a single-element edit to the
-- ARRAY literal rather than a key rename.

CREATE OR REPLACE FUNCTION public.analytics_smoke_run()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_t0 timestamptz;
  v_ms int;
  v_detail jsonb;
  v_started_at timestamptz := clock_timestamp();
  v_rpc text;
  -- Collections excluded from sales-freshness stale-count alerts because they
  -- routinely sit >24h between sales (low volume / dormant marketplaces).
  v_low_volume_collections text[] := ARRAY['ufc_strike', 'laliga_golazos'];
BEGIN
  PERFORM set_config('statement_timeout', '5000', true);

  -- (1.1) analytics_sales_summary must include prior_period and produce non-NULL volume
  v_t0 := clock_timestamp();
  BEGIN
    WITH r AS (SELECT analytics_sales_summary(now() - interval '30 days', now(), ARRAY['topshot']::text[]) AS payload)
    SELECT jsonb_build_object(
      'has_prior',          (r.payload -> 'prior_period') IS NOT NULL,
      'has_prior_volume',   (r.payload -> 'prior_period' ->> 'total_volume_usd') IS NOT NULL,
      'volume_30d',         (r.payload ->> 'total_volume_usd')::numeric,
      'total_sales',        (r.payload ->> 'total_sales')::int
    ) INTO v_detail FROM r;
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'rpc_sales_summary_topshot_30d',
      'severity', CASE
        WHEN (v_detail->>'has_prior')::bool = false THEN 'fail'
        WHEN (v_detail->>'has_prior_volume')::bool = false THEN 'fail'
        WHEN COALESCE((v_detail->>'volume_30d')::numeric, 0) < 1000 THEN 'warn'
        ELSE 'ok' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','rpc_sales_summary_topshot_30d','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- (1.2) analytics_liquidity_distribution
  v_t0 := clock_timestamp();
  BEGIN
    WITH r AS (SELECT analytics_liquidity_distribution(NULL) AS payload),
    rows AS (SELECT jsonb_array_elements(r.payload -> 'rows') AS row FROM r)
    SELECT jsonb_build_object(
      'collection_count', (SELECT count(*) FROM rows),
      'pinnacle_l5_plus_l1', COALESCE((SELECT (row->>'l5')::int + (row->>'l1')::int FROM rows WHERE row->>'collection' = 'pinnacle'), 0),
      'topshot_total', COALESCE((SELECT (row->>'total')::int FROM rows WHERE row->>'collection' = 'topshot'), 0),
      'collections_with_zero_total', (SELECT count(*) FROM rows WHERE (row->>'total')::int = 0)
    ) INTO v_detail FROM r;
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'rpc_liquidity_distribution',
      'severity', CASE
        WHEN COALESCE((v_detail->>'collection_count')::int, 0) < 4 THEN 'fail'
        WHEN COALESCE((v_detail->>'pinnacle_l5_plus_l1')::int, 0) = 0 THEN 'fail'
        WHEN COALESCE((v_detail->>'topshot_total')::int, 0) < 1000 THEN 'warn'
        WHEN COALESCE((v_detail->>'collections_with_zero_total')::int, 0) > 0 THEN 'warn'
        ELSE 'ok' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','rpc_liquidity_distribution','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- (1.3) analytics_fmv_tier_pulse
  v_t0 := clock_timestamp();
  BEGIN
    SELECT jsonb_build_object(
      'distinct_collections', count(DISTINCT collection),
      'collection_list', array_agg(DISTINCT collection ORDER BY collection)
    ) INTO v_detail FROM analytics_fmv_tier_pulse();
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'rpc_fmv_tier_pulse_collections',
      'severity', CASE WHEN (v_detail->>'distinct_collections')::int < 4 THEN 'fail' ELSE 'ok' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','rpc_fmv_tier_pulse_collections','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- (1.4..) Schema-only smoke
  FOR v_rpc IN
    SELECT unnest(ARRAY[
      'analytics_pulse_24h','analytics_sets_summary','analytics_packs_summary',
      'analytics_listings_summary','analytics_pipeline_health','analytics_data_quality_overview',
      'analytics_wallets_overview','analytics_fmv_pipeline_health'])
  LOOP
    v_t0 := clock_timestamp();
    BEGIN
      EXECUTE format('SELECT %I()', v_rpc);
      v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
      v_results := v_results || jsonb_build_object(
        'name', 'rpc_schema_' || v_rpc, 'severity', 'ok', 'ms', v_ms, 'detail', '{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_object(
        'name', 'rpc_schema_' || v_rpc, 'severity', 'fail',
        'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
        'detail', jsonb_build_object('error', SQLERRM));
    END;
  END LOOP;

  -- (2.1) Sales freshness — exclude low-volume collections from stale alert
  v_t0 := clock_timestamp();
  BEGIN
    WITH freshness AS (
      SELECT c.slug, max(s.sold_at) AS last_sale,
             EXTRACT(EPOCH FROM now() - max(s.sold_at)) / 60 AS minutes_stale
      FROM collections c LEFT JOIN sales s ON s.collection_id = c.id
      WHERE c.is_active = true AND c.slug != 'disney_pinnacle' GROUP BY c.slug),
    pinnacle AS (
      SELECT 'disney_pinnacle' AS slug, max(sold_at) AS last_sale,
             EXTRACT(EPOCH FROM now() - max(sold_at)) / 60 AS minutes_stale FROM pinnacle_sales),
    combined AS (SELECT * FROM freshness UNION ALL SELECT * FROM pinnacle)
    SELECT jsonb_build_object(
      'per_collection', jsonb_object_agg(slug, jsonb_build_object('minutes_stale', round(minutes_stale)::int, 'last_sale', last_sale)),
      'low_volume_excluded', to_jsonb(v_low_volume_collections),
      'stale_count_excl_low_volume', count(*) FILTER (WHERE minutes_stale > 1440 AND NOT (slug = ANY(v_low_volume_collections)))
    ) INTO v_detail FROM combined;
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'freshness_sales_per_collection',
      'severity', CASE WHEN (v_detail->>'stale_count_excl_low_volume')::int > 0 THEN 'fail' ELSE 'ok' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','freshness_sales_per_collection','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- (2.2) FMV freshness
  v_t0 := clock_timestamp();
  BEGIN
    WITH fmv AS (
      SELECT c.slug, EXTRACT(EPOCH FROM now() - max(fs.computed_at)) / 60 AS minutes_stale
      FROM collections c LEFT JOIN fmv_snapshots fs ON fs.collection_id = c.id
      WHERE c.is_active = true AND c.slug != 'disney_pinnacle' GROUP BY c.slug),
    pinnacle AS (
      SELECT 'disney_pinnacle' AS slug, EXTRACT(EPOCH FROM now() - max(computed_at)) / 60 AS minutes_stale
      FROM pinnacle_fmv_snapshots),
    combined AS (SELECT * FROM fmv UNION ALL SELECT * FROM pinnacle)
    SELECT jsonb_build_object(
      'per_collection', jsonb_object_agg(slug, round(minutes_stale)::int),
      'stale_count', count(*) FILTER (WHERE minutes_stale > 60)
    ) INTO v_detail FROM combined;
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'freshness_fmv_per_collection',
      'severity', CASE
        WHEN (v_detail->>'stale_count')::int > 1 THEN 'fail'
        WHEN (v_detail->>'stale_count')::int > 0 THEN 'warn'
        ELSE 'ok' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','freshness_fmv_per_collection','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- (3) Pipeline health 24h
  v_t0 := clock_timestamp();
  BEGIN
    WITH p AS (
      SELECT count(*) AS total, count(*) FILTER (WHERE ok = false) AS failed
      FROM pipeline_runs WHERE started_at >= now() - interval '24 hours'),
    failing AS (
      SELECT pipeline, count(*) AS fails
      FROM pipeline_runs WHERE started_at >= now() - interval '24 hours' AND ok = false
      GROUP BY pipeline HAVING count(*) >= 3 ORDER BY count(*) DESC)
    SELECT jsonb_build_object(
      'total_24h', p.total,
      'failed_24h', p.failed,
      'failure_pct', round(100.0 * p.failed::numeric / nullif(p.total, 0), 2),
      'sustained_failing', COALESCE((SELECT jsonb_object_agg(pipeline, fails) FROM failing), '{}'::jsonb)
    ) INTO v_detail FROM p;
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'pipeline_health_24h',
      'severity', CASE
        WHEN (v_detail->>'failure_pct')::numeric > 10 THEN 'fail'
        WHEN (v_detail->>'failure_pct')::numeric > 5 THEN 'warn'
        WHEN (v_detail->'sustained_failing') != '{}'::jsonb THEN 'warn'
        ELSE 'ok' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','pipeline_health_24h','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- (4.1) fmv_snapshots collection drift = 0 (now structurally enforced by trigger)
  v_t0 := clock_timestamp();
  BEGIN
    SELECT jsonb_build_object('drift_rows', count(*)) INTO v_detail
    FROM fmv_snapshots fs JOIN collections c ON c.id = fs.collection_id
    WHERE fs.collection != c.slug;
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'integrity_fmv_snapshots_collection_drift',
      'severity', CASE WHEN (v_detail->>'drift_rows')::int = 0 THEN 'ok' ELSE 'fail' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','integrity_fmv_snapshots_collection_drift','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- (4.2) Locked-down SECDEF stay locked
  v_t0 := clock_timestamp();
  BEGIN
    WITH locked AS (
      SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY(ARRAY[
        'allow_list_decide','allow_list_claim_prewarm','allow_list_finish_prewarm','allow_list_mark_welcome_sent',
        'sync_seeded_wallet_to_username_cache','mark_signal_wallets_fully_enriched',
        'tg_capture_topshot_insider_marketplace_buyback','compute_institutional_wallet_diff',
        'save_fast_break_lineup','log_cart_purchase'])
        AND has_function_privilege('anon', p.oid, 'EXECUTE'))
    SELECT jsonb_build_object('leaked_count', count(*), 'leaked_list', array_agg(proname))
    INTO v_detail FROM locked;
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'security_locked_secdef_remain_locked',
      'severity', CASE WHEN (v_detail->>'leaked_count')::int = 0 THEN 'ok' ELSE 'fail' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','security_locked_secdef_remain_locked','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- (4.3) RLS on every public table
  v_t0 := clock_timestamp();
  BEGIN
    SELECT jsonb_build_object(
      'tables_no_rls_count', count(*),
      'tables_no_rls', array_agg(t.tablename ORDER BY t.tablename)
    ) INTO v_detail
    FROM pg_tables t JOIN pg_class c ON c.relname = t.tablename
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
    WHERE t.schemaname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
    v_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int;
    v_results := v_results || jsonb_build_object(
      'name', 'security_all_tables_rls_enabled',
      'severity', CASE WHEN (v_detail->>'tables_no_rls_count')::int = 0 THEN 'ok' ELSE 'fail' END,
      'ms', v_ms, 'detail', v_detail);
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || jsonb_build_object('name','security_all_tables_rls_enabled','severity','fail',
      'ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_t0)::int,
      'detail', jsonb_build_object('error', SQLERRM));
  END;

  RETURN jsonb_build_object(
    'ran_at', v_started_at,
    'total_ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_started_at)::int,
    'check_count', jsonb_array_length(v_results),
    'fail_count', (SELECT count(*) FROM jsonb_array_elements(v_results) e WHERE e->>'severity' = 'fail'),
    'warn_count', (SELECT count(*) FROM jsonb_array_elements(v_results) e WHERE e->>'severity' = 'warn'),
    'overall_severity', CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_results) e WHERE e->>'severity' = 'fail') THEN 'fail'
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_results) e WHERE e->>'severity' = 'warn') THEN 'warn'
      ELSE 'ok' END,
    'results', v_results);
END;
$function$;
