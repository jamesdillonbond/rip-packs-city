-- Candy MLB parity (2026-09-20 ~8:39 AM PT, Claude Code cloud).
--
-- WHAT THIS FIXES, and it is the repo's top defect class, not a cosmetic gap.
-- `analytics_listings_summary` builds `marketplace_listings` from `cached_listings`
-- JOIN `collections`. Measured live this morning: Candy MLB has **0 rows in
-- cached_listings** (its asks are indexed into `candy_listings` by the Solana
-- listings indexer) while `candy_listings` carries **1,983 active, priced asks**,
-- last seen 2026-09-20 05:35 AM PT. So the RPC returned `marketplace_listings: []`
-- for Candy, and the Order Book Depth card on the collection analytics tab reads
-- `count === 0` as its EMPTY branch and renders **"No live listings."** — a
-- positive claim about the market made out of a table Candy was never written to.
--
-- Candy is the ONLY published collection with this split (Pinnacle's asks are in
-- cached_listings; the four Flow collections likewise). The precedent for the
-- shape below is `analytics_liquidity_distribution`, which already UNIONs a
-- Pinnacle branch off `pinnacle_catalog` for the same reason.
--
-- DEAD-LISTING FILTER: identical predicate to the shared arm (drop asks > 50x FMV,
-- else the $100K absolute floor when FMV is unknown), read from `candy_fmv_current`
-- — the same view `candy_market_board` (the live Market tab) already prices asks
-- against, so the two surfaces cannot disagree. Measured: 1,983 active priced asks
-- in, 68 removed by the filter, **1,915 out**.
--
-- COST, warm, measured before writing this file: **9.8 ms / 1,665 shared buffers**
-- (cold 5.0 s on a saturated instance — read=494, the estate's IO spell, not this
-- query). The `candy_fmv_current` DISTINCT ON over 7,088 snapshot rows to 125
-- editions is 857 of those buffers. Bounded by Candy's 125-edition catalogue.
--
-- The `coll` key is `candy_mlb` — the LONG slug — deliberately, because the shared
-- arm's `CASE ... ELSE c.slug` already emits `candy_mlb` for Candy everywhere else
-- in this RPC family (`analytics_sets_directory`, `analytics_liquidity_distribution`),
-- and `lib/analytics-sets-dashboard-compute.ts` has labelled that exact key since
-- 2026-07-31. Emitting a short 'candy' here would make this one function disagree
-- with every other analytics surface.
--
-- md5 GATE: this is a full-body CREATE OR REPLACE, so it is gated on the md5 of the
-- live prosrc read immediately before drafting. A concurrent session having touched
-- the function aborts the apply instead of silently reverting its work.
--
-- ⚠ The marker below MUST be one line carrying both "anon-exec:" and the function
-- name — the guard tests them per LINE, so splitting the reason across a comment
-- block makes the marker silently do nothing. It failed exactly that way on the
-- first draft of this file.
-- anon-exec: intentional — SNAPSHOT migration; CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would smuggle a production ACL change into a body rewrite. public.analytics_listings_summary is already service_role-only and stays that way — VERIFIED post-apply with has_function_privilege (not acl text): anon EXECUTE false, authenticated EXECUTE false, service_role EXECUTE true. Reached only through /api/analytics/listings/summary, a service-role route.
--
-- REVERT: re-apply the body without the `candy` CTE and without the UNION ALL —
-- i.e. `marketplace_listings` selects from the `cached_listings` sub-select alone.
-- The prior body's md5 is ba6ee5b9b3d906b8b9d64646f812d3d3 (4,319 chars).

DO $gate$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'analytics_listings_summary')
     IS DISTINCT FROM 'ba6ee5b9b3d906b8b9d64646f812d3d3'
  THEN
    RAISE EXCEPTION 'analytics_listings_summary body changed since this migration was drafted (expected md5 ba6ee5b9b3d906b8b9d64646f812d3d3) — re-read the live object and redraft rather than overwriting it';
  END IF;
END
$gate$;

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
  SELECT jsonb_build_object(
    'count',           COUNT(*),
    'min_ask_usd',     COALESCE(ROUND(MIN(price_usd)::numeric, 2), 0),
    'median_ask_usd',  COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_usd)::numeric, 2), 0),
    'p90_ask_usd',     COALESCE(ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY price_usd)::numeric, 2), 0),
    'max_ask_usd',     COALESCE(ROUND(MAX(price_usd)::numeric, 2), 0),
    'avg_ask_usd',     COALESCE(ROUND(AVG(price_usd)::numeric, 2), 0),
    'total_ask_usd',   COALESCE(ROUND(SUM(price_usd)::numeric, 2), 0),
    'locked_count',    COUNT(*) FILTER (WHERE is_locked)
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
  -- ⚠ 2026-09-20: the `candy` arm is NOT a duplicate of the shared arm — Candy's
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
  )
  SELECT jsonb_agg(jsonb_build_object(
    'collection', coll, 'count', n, 'min_ask_usd', mn, 'max_ask_usd', mx, 'avg_ask_usd', avg_v, 'median_ask_usd', med
  ) ORDER BY coll)
  INTO marketplace_listings
  FROM (SELECT * FROM shared UNION ALL SELECT * FROM candy) m;

  result := jsonb_build_object(
    'loan_offers',          loan_offers,
    'topshot_orderbook',    ts_orderbook,
    'marketplace_listings', COALESCE(marketplace_listings, '[]'::jsonb),
    'data_caveats', jsonb_build_object(
      'topshot_sample',     'ts_listings is a recent sample of the Top Shot orderbook, not the full state',
      'cached_sniper_bias', 'cached_listings is sourced from Sniper deal scans - biased toward low-priced inventory',
      'dead_listing_filter','Dropped asks > 50x FMV (or > $100K when FMV unknown) to exclude listing-reward farming',
      'candy_source',       'Candy MLB asks come from candy_listings (Solana / Magic Eden), not cached_listings, and are a full active-ask snapshot rather than a Sniper-scan sample'
    ),
    'as_of', now()
  );

  RETURN result;
END;
$function$;
