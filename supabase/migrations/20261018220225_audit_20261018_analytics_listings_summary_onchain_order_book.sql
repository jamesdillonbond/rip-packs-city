-- audit_20261018 — analytics_listings_summary: All Day + Golazos Order Book Depth from the on-chain book.
--
-- WHY. The Analytics page's Order Book Depth card (marketplace_listings) counted
-- All Day and Golazos from v1 `cached_listings`, which holds only Flowty's book
-- for them: 108 / 100 rows on 2026-10-18 against ~34k / ~4.3k open on-chain
-- asks. The card published Flowty's slice as the order book, and would read
-- "No live listings." on the day Flowty's API goes dark — the same shape the
-- Candy (09-20) and Pinnacle (09-28) arms fixed.
--
-- WHAT CHANGES. The shared v1 arm skips nfl_all_day / laliga_golazos; a new
-- `onchain` arm counts them from cached_listings_v2 (open, priced, unexpired,
-- not 'flowty', not a sold-after-listing ghost — the All Day market's rule).
-- FMV for the shared dead-listing filter is resolved once per EDITION (latest
-- fmv_snapshots row), not per listing through fmv_current. A new data_caveats
-- key says where the numbers come from. Output shape, other arms,
-- volatility, SECURITY DEFINER, search_path and ACL are unchanged.
-- Measured (prototype, both collections): 358 ms, ~38.8k buffers; the route
-- caches 300 s and the function runs ~87 times a day.
--
-- Built from live prosrc md5 0a3f2f6c86c3f53c639a1f0e143f24f7 (= the body of
-- 20260929022013); the guard requires it. DB invariant updated verbatim:
-- supabase/tests/analytics_listings_summary.sql.
-- anon-exec: revoked (analytics_listings_summary) — REVOKEd from PUBLIC, anon, authenticated below and re-GRANTed to service_role (the analytics routes' caller).
--
-- REVERT: re-apply analytics_listings_summary from 20260929022013_audit_20260928_pinnacle_analytics_fmv_health_and_order_book.sql.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'analytics_listings_summary' AND pronamespace = 'public'::regnamespace) <> '0a3f2f6c86c3f53c639a1f0e143f24f7' THEN
    RAISE EXCEPTION 'analytics_listings_summary live body is not the one this migration was built from — re-read before a full-body write';
  END IF;
END $guard$;

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
      -- 2026-10-18: All Day and Golazos are counted from the on-chain book
      -- (the `onchain` arm below). Their v1 rows are Flowty's alone (108 / 100
      -- rows vs ~34k / ~4.3k open on-chain asks).
      AND c.slug NOT IN ('nfl_all_day', 'laliga_golazos')
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
  -- 2026-10-18: All Day + Golazos from the on-chain listing index
  -- (cached_listings_v2): open, priced, unexpired, not Flowty, and not a ghost
  -- (allday_listings_sold_after_listing, the same rule as the All Day market).
  -- FMV is resolved once per EDITION, not joined per listing through the
  -- fmv_current view, which would build the whole view; the dead-listing filter
  -- is the shared one.
  onchain_l AS MATERIALIZED (
    SELECT CASE c.slug WHEN 'nfl_all_day' THEN 'allday' ELSE 'golazos' END AS coll,
           l.edition_id, l.price_usd
      FROM cached_listings_v2 l
      JOIN collections c ON c.id = l.collection_id
     WHERE c.slug IN ('nfl_all_day', 'laliga_golazos')
       AND (p_collections IS NULL OR
            CASE c.slug WHEN 'nfl_all_day' THEN 'allday' ELSE 'golazos' END = ANY(p_collections))
       AND l.completed_at IS NULL
       AND l.price_usd > 0
       AND l.source <> 'flowty'
       AND (l.expiry_at IS NULL OR l.expiry_at > now())
       AND NOT EXISTS (
         SELECT 1 FROM allday_listings_sold_after_listing g
          WHERE g.listing_resource_id = l.listing_resource_id AND g.source = l.source
       )
  ),
  onchain_fmv AS MATERIALIZED (
    SELECT d.edition_id, f.fmv_usd
      FROM (SELECT DISTINCT edition_id FROM onchain_l WHERE edition_id IS NOT NULL) d
      LEFT JOIN LATERAL (
        SELECT s.fmv_usd FROM fmv_snapshots s
         WHERE s.edition_id = d.edition_id AND s.fmv_usd IS NOT NULL
         ORDER BY s.computed_at DESC
         LIMIT 1
      ) f ON true
  ),
  onchain AS (
    SELECT
      ol.coll                                                   AS coll,
      COUNT(*)                                                  AS n,
      ROUND(MIN(ol.price_usd)::numeric, 2)                      AS mn,
      ROUND(MAX(ol.price_usd)::numeric, 2)                      AS mx,
      ROUND(AVG(ol.price_usd)::numeric, 2)                      AS avg_v,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ol.price_usd)::numeric, 2) AS med
    FROM onchain_l ol
    LEFT JOIN onchain_fmv ef ON ef.edition_id = ol.edition_id
    WHERE (ef.fmv_usd IS NOT NULL AND ol.price_usd <= ef.fmv_usd * 50)
       OR (ef.fmv_usd IS NULL AND ol.price_usd < 100000)
    GROUP BY ol.coll
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
  FROM (SELECT * FROM shared UNION ALL SELECT * FROM onchain UNION ALL SELECT * FROM candy UNION ALL SELECT * FROM pinnacle) m;

  result := jsonb_build_object(
    'loan_offers',          loan_offers,
    'topshot_orderbook',    ts_orderbook,
    'marketplace_listings', COALESCE(marketplace_listings, '[]'::jsonb),
    'data_caveats', jsonb_build_object(
      'topshot_sample',     'ts_listings is a recent sample of the Top Shot orderbook, not the full state',
      'cached_sniper_bias', 'cached_listings is sourced from Sniper deal scans - biased toward low-priced inventory',
      'dead_listing_filter','Dropped asks > 50x FMV (or > $100K when FMV unknown) to exclude listing-reward farming',
      'candy_source',       'Candy MLB asks come from candy_listings (Solana / Magic Eden), not cached_listings, and are a full active-ask snapshot rather than a Sniper-scan sample',
      'pinnacle_source',    'Disney Pinnacle asks come from pinnacle_live_listings (the marketplace sweep), not cached_listings, and are a full active-ask snapshot rather than a Sniper-scan sample',
      'onchain_source',     'NFL All Day and LaLiga Golazos asks come from the on-chain listing index (cached_listings_v2), not cached_listings: every open, unexpired listing, with sold-after-listing ghosts and Flowty rows excluded'
    ),
    'as_of', now()
  );

  RETURN result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.analytics_listings_summary(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_listings_summary(text[]) TO service_role;

DO $verify$
DECLARE
  v_ls jsonb;
  v_n  int;
BEGIN
  v_ls := public.analytics_listings_summary(ARRAY['allday', 'golazos']);
  SELECT count(*) INTO v_n
    FROM jsonb_array_elements(v_ls->'marketplace_listings') m
   WHERE m->>'collection' IN ('allday', 'golazos') AND (m->>'count')::int > 1000;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'post-condition failed: expected both on-chain arms with > 1000 asks, got %', v_ls->'marketplace_listings';
  END IF;
END $verify$;
