-- audit_20260928_pinnacle_analytics_fmv_health_and_order_book
--
-- Two Analytics cards said Pinnacle had no data when it does (live 2026-09-28):
--   * FMV Health → "No FMV coverage yet." analytics_fmv_tier_pulse reads
--     fmv_snapshots_2026 only, and Pinnacle's FMV lives on pinnacle_catalog
--     (0 Pinnacle snapshot rows; 1,580 priced, non-ask pins in the catalog).
--     Adds a catalog arm with the same filters (last 24 h, not ASK_ONLY, has a
--     price), the pin's variant standing in for tier, and drops Pinnacle from
--     the snapshot arm so a stray snapshot row can never count twice.
--   * Order Book Depth → "No live listings." analytics_listings_summary never
--     read pinnacle_live_listings (17,021 asks; 0 Pinnacle rows in
--     cached_listings). Adds a 'pinnacle' arm beside the Candy one, with the
--     shared dead-listing filter against the pin's catalog FMV.
--
-- NOT changed: analytics_packs_summary still has no Pinnacle mapping, on
-- purpose. Pinnacle's pack_ev_history rows are per sub-distribution of a drop
-- priced on ask-only FMV (a 5-pack "Quinova" pool reads EV $4,045 on a $4.99
-- pack), so the card's "Pack analytics not yet available" is the true state
-- until that model is fixed.
--
-- analytics_fmv_tier_pulse's live body (md5 ea5723035548c0ffafa54d0858444e72)
-- was not in any committed migration; this file now defines it.
--
-- anon-exec: revoked (analytics_fmv_tier_pulse) — REVOKEd from PUBLIC, anon, authenticated below and re-GRANTed to service_role (the analytics routes' caller).
-- anon-exec: revoked (analytics_listings_summary) — REVOKEd from PUBLIC, anon, authenticated below and re-GRANTed to service_role (the analytics routes' caller).
--
-- Pins: supabase/tests/analytics_fmv_tier_pulse.sql,
--       supabase/tests/analytics_listings_summary.sql (DDL verbatim).
-- Revert: re-apply analytics_listings_summary from 20260920163320; for
-- analytics_fmv_tier_pulse, restore the 'disney_pinnacle' WHEN arm, drop the
-- slug exclusion and the pinnacle_fmv/unioned CTEs.

CREATE OR REPLACE FUNCTION public.analytics_fmv_tier_pulse(p_collections text[] DEFAULT NULL::text[])
 RETURNS TABLE(collection text, tier text, edition_count bigint, total_fmv_usd numeric, avg_fmv_usd numeric, median_fmv_usd numeric, high_conf_count bigint, low_conf_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH latest_fmv AS (
    SELECT DISTINCT ON (s.edition_id)
      s.edition_id,
      s.fmv_usd,
      s.confidence::text AS confidence,
      (CASE c.slug
        WHEN 'nba_top_shot'    THEN 'topshot'
        WHEN 'nfl_all_day'     THEN 'allday'
        WHEN 'laliga_golazos'  THEN 'golazos'
        WHEN 'ufc_strike'      THEN 'ufc'
        ELSE c.slug::text
      END)::text AS coll
    FROM fmv_snapshots_2026 s
    JOIN collections c ON c.id = s.collection_id
    WHERE s.computed_at >= now() - interval '24 hours'
      AND s.confidence != 'ASK_ONLY'
      AND c.is_active = true
      AND c.slug <> 'disney_pinnacle'
    ORDER BY s.edition_id, s.computed_at DESC
  ),
  -- 2026-09-28: Pinnacle's FMV lives on pinnacle_catalog (one row per pin) and
  -- is never written to fmv_snapshots_2026 (measured: 0 rows), so the FMV Health
  -- card read "No FMV coverage yet." for a collection with 1,580 priced pins.
  -- Same filters as the arm above: computed in the last 24 h, not ASK_ONLY, has
  -- a price. Pinnacle has no rarity tier; the pin's variant stands in for it.
  pinnacle_fmv AS (
    SELECT
      pc.fmv_usd,
      pc.fmv_confidence::text AS confidence,
      'pinnacle'::text AS coll,
      pc.variant AS pin_tier
    FROM pinnacle_catalog pc
    WHERE pc.fmv_computed_at >= now() - interval '24 hours'
      AND pc.fmv_usd IS NOT NULL
      AND pc.fmv_confidence::text <> 'ASK_ONLY'
  ),
  unioned AS (
    SELECT f.coll, COALESCE(e.tier::text, 'UNKNOWN') AS t, f.fmv_usd, f.confidence
    FROM latest_fmv f
    LEFT JOIN editions e ON e.id = f.edition_id
    UNION ALL
    SELECT p.coll, COALESCE(p.pin_tier, 'UNKNOWN') AS t, p.fmv_usd, p.confidence
    FROM pinnacle_fmv p
  )
  SELECT
    u.coll AS collection,
    u.t AS tier,
    COUNT(*)::bigint                                                                AS edition_count,
    COALESCE(ROUND(SUM(u.fmv_usd)::numeric, 0), 0)                                  AS total_fmv_usd,
    COALESCE(ROUND(AVG(u.fmv_usd)::numeric, 2), 0)                                  AS avg_fmv_usd,
    COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY u.fmv_usd)::numeric, 2), 0) AS median_fmv_usd,
    COUNT(*) FILTER (WHERE u.confidence = 'HIGH')::bigint                           AS high_conf_count,
    COUNT(*) FILTER (WHERE u.confidence = 'LOW')::bigint                            AS low_conf_count
  FROM unioned u
  WHERE (p_collections IS NULL OR u.coll = ANY(p_collections))
  GROUP BY u.coll, u.t
  ORDER BY total_fmv_usd DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.analytics_listings_summary(p_collections text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
  loan_offers jsonb;
  ts_orderbook jsonb;
  marketplace_listings jsonb;
BEGIN
  -- Section 1: Open Flowty loan offers
  SELECT jsonb_build_object(
    'count',                 COUNT(*),
    'total_principal_usd',   COALESCE(ROUND(SUM(principal_usd)::numeric, 2), 0),
    'avg_principal_usd',     COALESCE(ROUND(AVG(principal_usd)::numeric, 2), 0),
    'avg_apr',               COALESCE(ROUND((AVG(interest_rate * (365.0 * 86400.0 / NULLIF(term_seconds, 0))))::numeric, 4), 0),
    'avg_term_days',         COALESCE(ROUND(AVG(term_seconds / 86400.0)::numeric, 1), 0),
    'collections',           COALESCE((
      SELECT jsonb_object_agg(c, jsonb_build_object('count', n, 'principal_usd', usd))
      FROM (
        SELECT collection AS c, COUNT(*) AS n,
               COALESCE(ROUND(SUM(principal_usd)::numeric, 2), 0) AS usd
        FROM flowty_open_listings
        WHERE (p_collections IS NULL OR collection = ANY(p_collections))
        GROUP BY collection
      ) t
    ), '{}'::jsonb)
  )
  INTO loan_offers
  FROM flowty_open_listings
  WHERE (p_collections IS NULL OR collection = ANY(p_collections));

  -- Section 2: Top Shot orderbook (filtered)
  --
  -- `newest_ingested_at` / `age_hours` are the block's PROVENANCE. The rendering
  -- surface gates on them instead of on a hardcoded retirement date. NULL when
  -- the filtered set is empty: an unknown age, never a zero.
  SELECT jsonb_build_object(
    'count',           COUNT(*),
    'min_ask_usd',     COALESCE(ROUND(MIN(price_usd)::numeric, 2), 0),
    'median_ask_usd',  COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_usd)::numeric, 2), 0),
    'p90_ask_usd',     COALESCE(ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY price_usd)::numeric, 2), 0),
    'max_ask_usd',     COALESCE(ROUND(MAX(price_usd)::numeric, 2), 0),
    'avg_ask_usd',     COALESCE(ROUND(AVG(price_usd)::numeric, 2), 0),
    'total_ask_usd',   COALESCE(ROUND(SUM(price_usd)::numeric, 2), 0),
    'locked_count',    COUNT(*) FILTER (WHERE is_locked),
    'newest_ingested_at', MAX(ingested_at),
    'age_hours',       CASE WHEN MAX(ingested_at) IS NULL THEN NULL
                            ELSE ROUND((EXTRACT(epoch FROM (now() - MAX(ingested_at))) / 3600.0)::numeric, 2) END
  )
  INTO ts_orderbook
  FROM ts_listings
  WHERE price_usd > 0 AND price_usd < 100000
    AND (p_collections IS NULL OR 'topshot' = ANY(p_collections));

  -- Section 3: Per-collection NFT marketplace listings.
  -- Smarter dead-listing filter: when fmv exists, drop asks > 50x FMV.
  -- When fmv missing, fall back to the absolute $100K floor.
  -- Audit 2026-05-20: emit a JSON ARRAY of { collection, ... } objects.
  --
  -- 2026-09-20: the `candy` arm is NOT a duplicate of the shared arm -- Candy's
  -- asks are never written to `cached_listings` (measured: 0 rows) because the
  -- Solana listings indexer targets `candy_listings`. Without it this function
  -- reports an EMPTY order book for a collection carrying ~1,900 live asks, and
  -- the Order Book Depth card renders that as "No live listings."
  WITH shared AS (
    SELECT
      CASE c.slug
        WHEN 'nba_top_shot'   THEN 'topshot'
        WHEN 'nfl_all_day'    THEN 'allday'
        WHEN 'laliga_golazos' THEN 'golazos'
        WHEN 'ufc_strike'     THEN 'ufc'
        ELSE c.slug
      END                                                       AS coll,
      COUNT(*)                                                  AS n,
      ROUND(MIN(cl.ask_price)::numeric, 2)                      AS mn,
      ROUND(MAX(cl.ask_price)::numeric, 2)                      AS mx,
      ROUND(AVG(cl.ask_price)::numeric, 2)                      AS avg_v,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cl.ask_price)::numeric, 2) AS med
    FROM cached_listings cl
    JOIN collections c ON c.id = cl.collection_id
    WHERE cl.ask_price > 0
      AND (
        (cl.fmv IS NOT NULL AND cl.ask_price <= cl.fmv * 50)
        OR (cl.fmv IS NULL AND cl.ask_price < 100000)
      )
      AND (p_collections IS NULL OR
           CASE c.slug
             WHEN 'nba_top_shot'   THEN 'topshot'
             WHEN 'nfl_all_day'    THEN 'allday'
             WHEN 'laliga_golazos' THEN 'golazos'
             WHEN 'ufc_strike'     THEN 'ufc'
             ELSE c.slug
           END = ANY(p_collections))
    GROUP BY 1
  ),
  candy AS (
    SELECT
      'candy_mlb'::text                                         AS coll,
      COUNT(*)                                                  AS n,
      ROUND(MIN(l.price_usd)::numeric, 2)                       AS mn,
      ROUND(MAX(l.price_usd)::numeric, 2)                       AS mx,
      ROUND(AVG(l.price_usd)::numeric, 2)                       AS avg_v,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY l.price_usd)::numeric, 2) AS med
    FROM candy_listings l
    LEFT JOIN candy_fmv_current fc ON fc.edition_id = l.edition_id
    WHERE l.is_active
      AND l.price_usd IS NOT NULL
      AND l.price_usd > 0
      AND (
        (fc.fmv_usd IS NOT NULL AND l.price_usd <= fc.fmv_usd * 50)
        OR (fc.fmv_usd IS NULL AND l.price_usd < 100000)
      )
      AND (p_collections IS NULL OR 'candy_mlb' = ANY(p_collections))
    HAVING COUNT(*) > 0
  ),
  -- 2026-09-28: Pinnacle's asks are never written to cached_listings either
  -- (measured: 0 rows); the marketplace sweep replaces pinnacle_live_listings
  -- wholesale (17,021 asks). Without this arm the Pinnacle Order Book Depth card
  -- read "No live listings." Same dead-listing filter, FMV from the catalog.
  pinnacle AS (
    SELECT
      'pinnacle'::text                                          AS coll,
      COUNT(*)                                                  AS n,
      ROUND(MIN(l.price_usd)::numeric, 2)                       AS mn,
      ROUND(MAX(l.price_usd)::numeric, 2)                       AS mx,
      ROUND(AVG(l.price_usd)::numeric, 2)                       AS avg_v,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY l.price_usd)::numeric, 2) AS med
    FROM pinnacle_live_listings l
    LEFT JOIN pinnacle_catalog pc ON pc.render_id = l.render_id
    WHERE l.price_usd IS NOT NULL
      AND l.price_usd > 0
      AND (
        (pc.fmv_usd IS NOT NULL AND l.price_usd <= pc.fmv_usd * 50)
        OR (pc.fmv_usd IS NULL AND l.price_usd < 100000)
      )
      AND (p_collections IS NULL OR 'pinnacle' = ANY(p_collections))
    HAVING COUNT(*) > 0
  )
  SELECT jsonb_agg(jsonb_build_object(
    'collection', coll, 'count', n, 'min_ask_usd', mn, 'max_ask_usd', mx, 'avg_ask_usd', avg_v, 'median_ask_usd', med
  ) ORDER BY coll)
  INTO marketplace_listings
  FROM (SELECT * FROM shared UNION ALL SELECT * FROM candy UNION ALL SELECT * FROM pinnacle) m;

  result := jsonb_build_object(
    'loan_offers',          loan_offers,
    'topshot_orderbook',    ts_orderbook,
    'marketplace_listings', COALESCE(marketplace_listings, '[]'::jsonb),
    'data_caveats', jsonb_build_object(
      'topshot_sample',     'ts_listings is a recent sample of the Top Shot orderbook, not the full state',
      'cached_sniper_bias', 'cached_listings is sourced from Sniper deal scans - biased toward low-priced inventory',
      'dead_listing_filter','Dropped asks > 50x FMV (or > $100K when FMV unknown) to exclude listing-reward farming',
      'candy_source',       'Candy MLB asks come from candy_listings (Solana / Magic Eden), not cached_listings, and are a full active-ask snapshot rather than a Sniper-scan sample',
      'pinnacle_source',    'Disney Pinnacle asks come from pinnacle_live_listings (the marketplace sweep), not cached_listings, and are a full active-ask snapshot rather than a Sniper-scan sample'
    ),
    'as_of', now()
  );

  RETURN result;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.analytics_fmv_tier_pulse(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_fmv_tier_pulse(text[]) TO service_role;
REVOKE EXECUTE ON FUNCTION public.analytics_listings_summary(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_listings_summary(text[]) TO service_role;

-- Post-flight: both cards now have Pinnacle data, inside the route budget.
DO $verify$
DECLARE v_n bigint; v_t0 timestamptz; v_ms numeric; v_ls jsonb;
BEGIN
  v_t0 := clock_timestamp();
  SELECT sum(edition_count) INTO v_n FROM public.analytics_fmv_tier_pulse(ARRAY['pinnacle']);
  v_ms := extract(epoch from (clock_timestamp() - v_t0)) * 1000;
  IF coalesce(v_n, 0) = 0 THEN RAISE EXCEPTION 'tier pulse: no Pinnacle rows'; END IF;
  IF v_ms > 8000 THEN RAISE EXCEPTION 'tier pulse took % ms', round(v_ms); END IF;
  v_t0 := clock_timestamp();
  v_ls := public.analytics_listings_summary(ARRAY['pinnacle']);
  v_ms := extract(epoch from (clock_timestamp() - v_t0)) * 1000;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_ls->'marketplace_listings') m
                 WHERE m->>'collection' = 'pinnacle' AND (m->>'count')::int > 0) THEN
    RAISE EXCEPTION 'listings summary: no Pinnacle entry';
  END IF;
  IF v_ms > 8000 THEN RAISE EXCEPTION 'listings summary took % ms', round(v_ms); END IF;
  RAISE NOTICE 'pinnacle: % priced pins, listings %', v_n, v_ls->'marketplace_listings';
END
$verify$;
