-- audit_20260802_trust_health_precompute_fmv_sanity_flags
-- Adds Leg 10 (fmv_sanity_flags) to rpc_trust_health_precompute_refresh.
-- REVERT: re-apply the prior definition of rpc_trust_health_precompute_refresh()
--         (this migration only ADDS a leg; removing the leg + the
--          DELETE FROM rpc_trust_health_precompute WHERE metric='fmv_sanity_flags'
--          restores the prior state), and revert the companion view migration.

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
  v_board   jsonb;
  v_packev_short numeric;
  v_empty   numeric;
  v_slow    numeric;
  v_fmvsanity numeric;
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

  -- Leg 10 (2026-08-02): TopShot FMV sanity flags -- MOVED OFF THE SENTINEL READ PATH.
  -- Inline, this arm cost 22.5s COLD / 2.1s warm (~80k buffers: a per-edition LATERAL
  -- latest-FMV probe across 12,984 canonical TopShot editions, then a per-set median).
  -- It was the single largest STRUCTURAL cost in v_rpc_trust_health -- the only arm that
  -- stayed expensive even warm -- and it pushed the view past the service_role 30s budget,
  -- so /api/sentinel could not read the board at all. That is the same failure mode already
  -- recorded for topshot_fmv_pct_stale_30d: a timeout reads as "0 breaches", i.e. the
  -- monitor fails BLIND. Its 80k-buffer working set was also evicting the other arms from
  -- cache on Micro, which is why neighbouring arms read cold (offer_edition_gap: 7.4s cold
  -- vs 68ms warm).
  -- Computed by SELECTing THE VIEW ITSELF, never a copy of its predicate, so the
  -- 2026-08-01 own-sales corroboration refinement (fire only when fmv < 0.6x the edition's
  -- OWN 30d sales median, on >=4 sales, with a >$50 gap, on top of the <12%-of-set-median
  -- test) travels automatically and can never drift from what the arm reports.
  -- Isolated: a throw here marks ONLY this metric 999 -> BREACH. It must never read 0,
  -- because an unavailable monitor has to be LOUD.
  t1 := clock_timestamp();
  BEGIN
    SELECT count(*)::numeric INTO v_fmvsanity FROM public.v_fmv_sanity_flags;
  EXCEPTION WHEN OTHERS THEN
    v_fmvsanity := 999;
  END;

  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  VALUES ('fmv_sanity_flags', v_fmvsanity, now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value,
        computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  -- Legs 2-5 (+ candy, 2026-08-01): per-collection FMV coverage staleness.
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
           ('ufc_fmv_pct_stale_30d',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
           ('candy_fmv_pct_stale_30d',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
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

  -- Leg 6: Panini serial sale-field MAPPING shortfall.
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

  -- Leg 7: sales serial-supply, worst collection.
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

  -- Leg 9 (runs BEFORE leg 8 -- cheaper first): pack-EV PUBLISH shortfall.
  t1 := clock_timestamp();
  BEGIN
    SELECT COALESCE(
             round(100.0 * (1.0
               - (SELECT count(*) FROM public.pack_ev_latest)::numeric
                 / NULLIF((SELECT count(DISTINCT h.pack_listing_id) FROM public.pack_ev_history h), 0)::numeric
             ), 2), 999)
      INTO v_packev_short;
  EXCEPTION WHEN OTHERS THEN
    v_packev_short := 999;
  END;

  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  VALUES ('pack_ev_publish_shortfall_pct', v_packev_short, now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value,
        computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  -- Leg 8 (LAST -- most expensive, ~44s warm): PUBLIC BOARD LIVENESS.
  -- Isolated: a probe failure or an unfinished sweep marks ONLY these two metrics
  -- 999; every other leg above is already written and keeps its value.
  t1 := clock_timestamp();
  BEGIN
    SELECT public.public_board_liveness_probe() INTO v_board;
    IF COALESCE((v_board->>'budget_exhausted')::boolean, false) THEN
      v_empty := 999; v_slow := 999;   -- incomplete sweep is INCONCLUSIVE, not green
    ELSE
      v_empty := (v_board->>'empty_or_error')::numeric;
      v_slow  := (v_board->>'slow')::numeric;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_board := jsonb_build_object('error', left(SQLSTATE || ': ' || SQLERRM, 500));
    v_empty := 999; v_slow := 999;
  END;

  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  VALUES ('public_board_empty_count', v_empty, now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
         ('public_board_slow_count',  v_slow, now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value,
        computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  RETURN jsonb_build_object(
    'fmv_sanity_flags', v_fmvsanity,
    'panini_sale_field_mapping_shortfall', v_short,
    'sales_serial_supply_worst_pct', v_serialsupply,
    'topshot_impossible_parallel_serials', v_serials,
    'parallel_serials_duration_ms', v_ms,
    'fmv_coverage', v_cov,
    'fmv_coverage_duration_ms', v_ms_cov,
    'board_liveness', v_board,
    'pack_ev_publish_shortfall_pct', v_packev_short,
    'total_duration_ms', round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000),
    'computed_at', now()
  );
END;
$function$;