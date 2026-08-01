-- Applied to prod 2026-07-31 PT via MCP (schema_migrations 20260801031619);
-- filed here for the on-disk revert path.
--
-- Leg 7: sales serial-supply. Share of freshly-ingested sales written with NO
-- serial_number, worst collection. Catches a sales writer silently dropping the
-- field: serial FMV / special-serials / jersey-match go blind while the pipeline
-- reports ok=true. Validated against 9 weeks of history (reconstructed via
-- audit_20260731_allday_serial_backfill): TopShot 0 breach-days in 64 (worst
-- 1.5%), AllDay first breach 2026-07-16 -- i.e. this would have caught the
-- 07-13 AllDay regression 15 days before it was found by hand.
--
-- PRECOMPUTED, not inline: ~12.4s. The sold_at predicate is what prunes the
-- partitions; WITHOUT a pinned collection the (collection, sold_at) index loses
-- its leading column, so a single-collection probe (148ms) badly understates it.
-- Do not "optimize" this back into the view on the strength of a per-collection
-- timing.
--
-- Window note: the sold_at >= now()-30d predicate is required for partition
-- pruning and therefore scopes this to the FORWARD indexers. A history-backfill
-- writer dropping serials on old sales is deliberately NOT covered here.
--
-- Revert: re-apply the prior definition (this migration only ADDS leg 7; legs
-- 1-6 are byte-identical), then
--   DELETE FROM public.rpc_trust_health_precompute WHERE metric='sales_serial_supply_worst_pct';
CREATE OR REPLACE FUNCTION public.rpc_trust_health_precompute_refresh()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  t0        timestamptz := clock_timestamp();
  t1        timestamptz;
  v_serials numeric;
  v_ms      integer;
  v_ms_cov  integer;
  v_cov     jsonb;
  v_short  numeric;
  v_serialsupply numeric;
BEGIN
  -- Leg 1: impossible parallel serials (unchanged).
  SELECT count(*)::numeric INTO v_serials
  FROM editions e
  JOIN sales s ON s.edition_id = e.id
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND e.external_id::text ~ '::'::text
    AND e.circulation_count > 0
    AND s.serial_number > e.circulation_count;

  v_ms := round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000);

  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  VALUES ('topshot_impossible_parallel_serials', v_serials, now(), v_ms)
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value,
        computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  -- Legs 2-5: per-collection FMV coverage staleness (share of priced editions whose LATEST
  -- FMV snapshot is >30d old). One pass over fmv_snapshots for all four.
  t1 := clock_timestamp();

  WITH latest AS (
    SELECT DISTINCT ON (fs.collection_id, fs.edition_id)
           fs.collection_id, fs.edition_id, fs.computed_at
    FROM fmv_snapshots fs
    ORDER BY fs.collection_id, fs.edition_id, fs.computed_at DESC
  ),
  agg AS (
    SELECT latest.collection_id,
           round(100.0 * count(*) FILTER (WHERE latest.computed_at < (now() - '30 days'::interval))::numeric
                 / NULLIF(count(*), 0)::numeric, 1) AS pct_stale_30d
    FROM latest GROUP BY latest.collection_id
  ),
  want(metric, collection_id) AS (
    VALUES ('topshot_fmv_pct_stale_30d', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
           ('allday_fmv_pct_stale_30d',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
           ('golazos_fmv_pct_stale_30d', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
           ('ufc_fmv_pct_stale_30d',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid)
  ),
  resolved AS (
    SELECT w.metric, COALESCE(a.pct_stale_30d, 0::numeric) AS value
    FROM want w LEFT JOIN agg a ON a.collection_id = w.collection_id
  ),
  ins AS (
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT r.metric, r.value, now(),
           round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM resolved r
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value,
          computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms
    RETURNING metric, value
  )
  SELECT jsonb_object_agg(ins.metric, ins.value) INTO v_cov FROM ins;

  v_ms_cov := round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000);

  -- Leg 6 (2026-08-01): Panini serial sale-field MAPPING shortfall -- rows where
  -- upstream DID send brought_at_price but our column is null. Measured at ~605ms
  -- inline (seq scan + jsonb extraction over ~49k serials), which is why it lives
  -- here and is read from the precompute table rather than computed in the view.
  -- This is deliberately NOT the upstream-outage signal; that is pct_upstream_supplied
  -- in v_panini_serial_sale_field_supply and has a different owner.
  t1 := clock_timestamp();
  SELECT COALESCE(max(v.mapping_shortfall), 0)::numeric INTO v_short
  FROM public.v_panini_serial_sale_field_supply v;

  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  VALUES ('panini_sale_field_mapping_shortfall', v_short, now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value,
        computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  -- Leg 7 (2026-07-31 PT): sales serial-supply, worst collection. See header.
  t1 := clock_timestamp();
  SELECT COALESCE(max(q.pct), 0)::numeric INTO v_serialsupply
  FROM (
    SELECT (100.0 * count(*) FILTER (WHERE COALESCE(s.serial_number, 0) = 0)) / count(*) AS pct
      FROM public.sales s
     WHERE s.sold_at >= now() - '30 days'::interval
       AND s.ingested_at >= now() - '24:00:00'::interval
       AND s.nft_id IS NOT NULL
       AND s.nft_id <> ''
     GROUP BY s.collection
    HAVING count(*) >= 200
  ) q;

  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  VALUES ('sales_serial_supply_worst_pct', v_serialsupply, now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value,
        computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  RETURN jsonb_build_object(
    'panini_sale_field_mapping_shortfall', v_short,
    'sales_serial_supply_worst_pct', v_serialsupply,
    'topshot_impossible_parallel_serials', v_serials,
    'parallel_serials_duration_ms', v_ms,
    'fmv_coverage', v_cov,
    'fmv_coverage_duration_ms', v_ms_cov,
    'total_duration_ms', round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000),
    'computed_at', now()
  );
END;
$function$;
