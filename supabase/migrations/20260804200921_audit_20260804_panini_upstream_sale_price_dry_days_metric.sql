-- 2026-08-04 · NEW precomputed metric: panini_upstream_sale_price_dry_days.
--
-- Leg 6 now computes TWO metrics from ONE pass over v_panini_serial_sale_field_supply.
-- No other leg changes. See the arm catches text (added in the paired view migration)
-- for the full finding; the short version:
--
--   Upstream supplied 35-45% of captured Panini serials with a sale price daily from
--   07-17 to 07-26, decayed to 13.09% (07-27) and 1.06% (07-28), then EXACTLY 0.00%
--   every day from 07-29 through 08-04. 44,299 serials captured since, 0 sale prices.
--   mapping_shortfall stayed 0 throughout, so OUR mapping is faithful -- this is a
--   pure upstream supply outage, and until now nothing watched it.
--
-- REVERT: restore the prior single-metric leg 6 (SELECT COALESCE(max(v.mapping_shortfall),0)
-- INTO v_short FROM public.v_panini_serial_sale_field_supply v) and drop the
-- panini_upstream_sale_price_dry_days row from rpc_trust_health_precompute.

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
  v_panini_dry numeric;
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
  --
  -- 2026-08-04: the TopShot leg is CANONICAL-ONLY. Before that change it read 32.2%
  -- and 6,263 of 6,263 stale editions were non-canonical UUID-keyed dupe residue, so
  -- 100% of the headline came from a population ts_uuid_dupes_created_24h already
  -- watches -- a dupe-growth event would have paged as a TopShot FMV repricing stall.
  -- edition_integrity_flags already excludes the same residue; this now matches it.
  -- The filter is scoped by collection_id because no other collection uses the
  -- 'setID:playID[::parallel]' external_id form, so applying it globally would zero
  -- every other leg's denominator.
  t1 := clock_timestamp();

  WITH latest AS (
    SELECT DISTINCT ON (fs.collection_id, fs.edition_id)
           fs.collection_id, fs.edition_id, fs.computed_at
    FROM fmv_snapshots fs
    ORDER BY fs.collection_id, fs.edition_id, fs.computed_at DESC
  ),
  elig AS (
    SELECT l.collection_id, l.edition_id, l.computed_at
    FROM latest l
    LEFT JOIN editions e ON e.id = l.edition_id
    WHERE l.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       OR e.external_id::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ),
  agg AS (
    SELECT elig.collection_id,
           round(100.0 * count(*) FILTER (WHERE elig.computed_at < (now() - '30 days'::interval))::numeric
                 / NULLIF(count(*), 0)::numeric, 1) AS pct_stale_30d
    FROM elig GROUP BY elig.collection_id
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

  -- Leg 6: Panini serial sale-field supply -- TWO metrics from ONE pass over
  -- v_panini_serial_sale_field_supply (a seq scan over ~59k serials plus jsonb,
  -- measured 297-605ms, which is the whole reason this leg is precomputed).
  --
  --   panini_sale_field_mapping_shortfall -- OUR ingest dropped a price upstream DID
  --     send. Reads 0; a defect we own and can fix.
  --   panini_upstream_sale_price_dry_days (NEW 2026-08-04) -- consecutive most-recent
  --     CAPTURE DAYS on which upstream supplied zero sale prices. A supply outage with
  --     a different owner entirely, and nothing watched it until now. Counted over
  --     capture days, never calendar days, so a sleeping ingest box writes no capture
  --     rows and cannot inflate it -- that failure is owned by panini_fmv_stale_hours.
  t1 := clock_timestamp();
  WITH src AS (
    SELECT v.capture_day, v.raw_supplied_sale_price, v.mapping_shortfall
    FROM public.v_panini_serial_sale_field_supply v
  ),
  runs AS (
    SELECT bool_or(s.raw_supplied_sale_price > 0) OVER (
             ORDER BY s.capture_day DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS seen_supply
    FROM src s
  )
  SELECT COALESCE(max(s2.mapping_shortfall), 0)::numeric,
         (SELECT count(*) FROM runs r WHERE NOT r.seen_supply)::numeric
    INTO v_short, v_panini_dry
  FROM src s2;

  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  VALUES ('panini_sale_field_mapping_shortfall', v_short, now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
         ('panini_upstream_sale_price_dry_days', COALESCE(v_panini_dry, 0), now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value,
        computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  -- Leg 7: sales serial-supply, worst collection.
  -- 2026-08-03: measured over an AGED cohort (ingested 3-10 days ago), NOT the
  -- last 24h. A NULL serial on a freshly-ingested row is in-flight work that
  -- sales-serial-backfill resolves within days (TopShot rate 26.7% at 6-24h ->
  -- 0.26% at 3-10d), so keying on fresh rows made this arm flap on a healthy
  -- system. The lower bound (3d) lets the backfill settle; the upper bound (10d)
  -- keeps the arm pointed at RECENT ingest so an old, already-known residue
  -- cannot hold it red forever. See the migration header for the full table.
  t1 := clock_timestamp();
  SELECT COALESCE(max(q.pct), 0)::numeric INTO v_serialsupply
  FROM (
    SELECT (100.0 * count(*) FILTER (WHERE COALESCE(s.serial_number, 0) = 0)) / count(*) AS pct
      FROM public.sales s
     WHERE s.sold_at >= now() - '30 days'::interval
       AND s.ingested_at >= now() - '10 days'::interval
       AND s.ingested_at <  now() - '3 days'::interval
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
    'panini_upstream_sale_price_dry_days', v_panini_dry,
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