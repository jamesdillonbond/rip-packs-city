-- audit_20260810_precompute_split_m1_leg_functions
--
-- D34-prerequisite precompute split, stage M1 of 3 (plan:
-- docs/audits/precompute-split-plan-2026-08-10.md). Creates 7 per-leg SECDEF
-- functions, each a faithful extraction of the corresponding leg of
-- rpc_trust_health_precompute_refresh() with: its own SET statement_timeout
-- (generous — the COMMIT in M2 is the isolation mechanism, not a tight cap),
-- schema-qualified references, and an outer EXCEPTION→999 handler so a leg
-- that fails/times out flips ONLY its own arm(s) to the loud 999 sentinel
-- (verified: 999 > every breach threshold — impossible_parallel 3,
-- serial_supply 5, fmv_sanity 1, panini_dry 3, pack_ev 10, board_empty 1,
-- fmv_stale 50; share/slow/shortfall are TRACK-only so 999 is a harmless
-- self-healing transient). INERT: nothing calls these yet (M2 adds the
-- orchestrator, M3 cuts the cron over). The monolith function is untouched.
--
-- Revert: DROP FUNCTION public.rpc_thp_leg_{impossible_parallel,fmv_sanity,
--   fmv_coverage,panini,serial_supply,pack_ev,board_liveness}();

-- ── Leg 1: impossible parallel serials (budget 300s; leg is ~225s even healthy — §5) ──
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_impossible_parallel()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '300s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT count(*)::numeric INTO v
    FROM public.editions e
    JOIN public.sales s ON s.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND e.external_id::text ~ '::'::text
      AND e.circulation_count > 0
      AND s.serial_number > e.circulation_count;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

-- ── Leg 10: TopShot FMV sanity flags (budget 180s) ──
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_sanity()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '180s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT count(*)::numeric INTO v FROM public.v_fmv_sanity_flags;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('fmv_sanity_flags', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('fmv_sanity_flags', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

-- ── Legs 2-5: per-collection FMV coverage staleness + HIGH/MED share (10 metrics, budget 240s) ──
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_coverage()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '240s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp();
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (fs.collection_id, fs.edition_id)
             fs.collection_id, fs.edition_id, fs.computed_at, fs.confidence
      FROM public.fmv_snapshots fs
      ORDER BY fs.collection_id, fs.edition_id, fs.computed_at DESC
    ),
    elig AS (
      SELECT l.collection_id, l.edition_id, l.computed_at, l.confidence
      FROM latest l
      LEFT JOIN public.editions e ON e.id = l.edition_id
      WHERE l.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         OR e.external_id::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    ),
    agg AS (
      SELECT elig.collection_id,
             round(100.0 * count(*) FILTER (WHERE elig.computed_at < (now() - '30 days'::interval))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS pct_stale_30d,
             round(100.0 * count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM'))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS high_med_pct
      FROM elig GROUP BY elig.collection_id
    ),
    want(metric, collection_id) AS (
      VALUES ('topshot_fmv_pct_stale_30d', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_pct_stale_30d',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_pct_stale_30d', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_pct_stale_30d',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_pct_stale_30d',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_share(metric, collection_id) AS (
      VALUES ('topshot_fmv_high_med_share_pct', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_high_med_share_pct',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_high_med_share_pct', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_high_med_share_pct',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_high_med_share_pct',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    resolved AS (
      SELECT w.metric, COALESCE(a.pct_stale_30d, 0::numeric) AS value
      FROM want w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      SELECT w.metric, COALESCE(a.high_med_pct, 0::numeric) AS value
      FROM want_share w LEFT JOIN agg a ON a.collection_id = w.collection_id
    )
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT r.metric, r.value, now(),
           round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM resolved r
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['topshot_fmv_pct_stale_30d','allday_fmv_pct_stale_30d','golazos_fmv_pct_stale_30d',
                      'ufc_fmv_pct_stale_30d','candy_fmv_pct_stale_30d',
                      'topshot_fmv_high_med_share_pct','allday_fmv_high_med_share_pct','golazos_fmv_high_med_share_pct',
                      'ufc_fmv_high_med_share_pct','candy_fmv_high_med_share_pct']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

-- ── Leg 6: Panini serial sale-field supply (2 metrics, budget 60s) ──
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_panini()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '60s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v_short numeric; v_dry numeric;
BEGIN
  BEGIN
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
      INTO v_short, v_dry
    FROM src s2;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('panini_sale_field_mapping_shortfall', v_short, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
           ('panini_sale_price_capture_dry_days', COALESCE(v_dry, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['panini_sale_field_mapping_shortfall','panini_sale_price_capture_dry_days']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

-- ── Leg 7: sales serial-supply worst collection (budget 180s) ──
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_serial_supply()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '180s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT COALESCE(max(q.pct), 0)::numeric INTO v
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
    VALUES ('sales_serial_supply_worst_pct', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('sales_serial_supply_worst_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

-- ── Leg 9: pack-EV publish shortfall (budget 120s) ──
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_pack_ev()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '120s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT COALESCE(
             round(100.0 * (1.0
               - (SELECT count(*) FROM public.pack_ev_latest)::numeric
                 / NULLIF((SELECT count(DISTINCT h.pack_listing_id) FROM public.pack_ev_history h), 0)::numeric
             ), 2), 999)
      INTO v;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pack_ev_publish_shortfall_pct', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pack_ev_publish_shortfall_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

-- ── Leg 8: PUBLIC BOARD LIVENESS probe (2 metrics, budget 300s) ──
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_board_liveness()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '300s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v_board jsonb; v_empty numeric; v_slow numeric;
BEGIN
  BEGIN
    BEGIN
      SELECT public.public_board_liveness_probe() INTO v_board;
      IF COALESCE((v_board->>'budget_exhausted')::boolean, false) THEN
        v_empty := 999; v_slow := 999;   -- incomplete sweep is INCONCLUSIVE, not green
      ELSE
        v_empty := (v_board->>'empty_or_error')::numeric;
        v_slow  := (v_board->>'slow')::numeric;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_empty := 999; v_slow := 999;
    END;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('public_board_empty_count', v_empty, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
           ('public_board_slow_count',  v_slow, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['public_board_empty_count','public_board_slow_count']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_impossible_parallel() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_fmv_sanity() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_fmv_coverage() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_panini() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_serial_supply() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_pack_ev() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_board_liveness() FROM PUBLIC, anon, authenticated;
