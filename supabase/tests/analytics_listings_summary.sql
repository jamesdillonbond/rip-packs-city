-- DB invariant: public.analytics_listings_summary — the Order Book Depth card
-- and the site-wide listings dashboard. Added 2026-09-28 with its Pinnacle arm:
-- Pinnacle's asks live in pinnacle_live_listings and never reach
-- cached_listings, so the card read "No live listings." over 17,021 asks.
--
-- Claims:
--   1. marketplace_listings carries a 'pinnacle' entry counted from
--      pinnacle_live_listings, with the shared dead-listing filter (> 50x the
--      pin's catalog FMV, or >= $100K with no FMV, is dropped).
--   2. The entry is absent when p_collections excludes 'pinnacle', and absent
--      (not a zero row) when there are no asks.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929022013_audit_20260928_pinnacle_analytics_fmv_health_and_order_book.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.flowty_open_listings (collection text, principal_usd numeric, interest_rate numeric, term_seconds numeric);
CREATE TABLE public.ts_listings (price_usd numeric, is_locked boolean, ingested_at timestamptz);
CREATE TABLE public.cached_listings (collection_id uuid, ask_price numeric, fmv numeric);
CREATE TABLE public.candy_listings (edition_id text, price_usd numeric, is_active boolean);
CREATE TABLE public.candy_fmv_current (edition_id text, fmv_usd numeric);
CREATE TABLE public.pinnacle_catalog (render_id text PRIMARY KEY, fmv_usd numeric);
CREATE TABLE public.pinnacle_live_listings (nft_id text, render_id text, serial_number int, price_usd numeric, seen_at timestamptz);

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
INSERT INTO public.pinnacle_catalog VALUES ('r1', 10), ('r2', NULL);
INSERT INTO public.pinnacle_live_listings VALUES
  ('n1', 'r1', 1, 5,      now()),
  ('n2', 'r1', 2, 15,     now()),
  ('n3', 'r1', 3, 600,    now()),   -- > 50x FMV: dropped
  ('n4', 'r2', 4, 40,     now()),
  ('n5', 'r2', 5, 150000, now());   -- no FMV, >= $100K: dropped

SELECT _assert_eq((SELECT m->>'count' FROM jsonb_array_elements(public.analytics_listings_summary(ARRAY['pinnacle'])->'marketplace_listings') m WHERE m->>'collection' = 'pinnacle'), '3', 'three live asks survive the dead-listing filter');
SELECT _assert_eq((SELECT (m->>'min_ask_usd') || '-' || (m->>'max_ask_usd') FROM jsonb_array_elements(public.analytics_listings_summary(ARRAY['pinnacle'])->'marketplace_listings') m WHERE m->>'collection' = 'pinnacle'), '5.00-40.00', 'min/max over the kept asks');
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(public.analytics_listings_summary(ARRAY['topshot'])->'marketplace_listings') m WHERE m->>'collection' = 'pinnacle'), '0', 'the filter excludes Pinnacle');
DELETE FROM public.pinnacle_live_listings;
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(public.analytics_listings_summary(ARRAY['pinnacle'])->'marketplace_listings') m WHERE m->>'collection' = 'pinnacle'), '0', 'no asks -> no entry, never a zero row');

SELECT '✓ analytics_listings_summary: all assertions passed' AS result;

ROLLBACK;
