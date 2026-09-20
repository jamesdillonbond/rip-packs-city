-- anon-exec: unchanged (analytics_listings_summary) — CREATE OR REPLACE of an EXISTING function, so the ACL is
-- preserved and a REVOKE here would silently CHANGE production while reading as a body-only
-- edit. Verified live 2026-09-20 ~10:1x AM PT with has_function_privilege (NOT the proacl
-- text): anon EXECUTE = false, authenticated EXECUTE = false, prosecdef = true.
-- ─────────────────────────────────────────────────────────────────────────────
-- The Top Shot orderbook block publishes its OWN freshness.
--
-- WHY. `ts_listings` was genuinely retired on 2026-05-26 (one row, 2026-05-15),
-- and `lib/analytics/ts-listings-retired.ts` + the per-collection analytics tab
-- were built to disclose that. On 2026-09-07 the table was rewired to the Atlas
-- firehose and is now rebuilt every 2 minutes: measured 2026-09-20 09:25 PT it
-- held 60,350 rows over 2,377 editions, oldest row 2026-09-19. The disclosure
-- was never revisited, so the public analytics tab has been telling anonymous
-- visitors "the sampler was switched off on 2026-05-26 and its last row was
-- written on 2026-05-15" about a feed that is two minutes old, and suppressing
-- a real 60k-row order book to do it. That is the #80 mirror: an `unknown`
-- that is actually KNOWN.
--
-- WHY THE FIX IS HERE AND NOT ONLY IN THE COPY. A hardcoded retirement date is
-- the failure mode itself -- it cannot notice that its premise expired, and the
-- ratchet guarding it is explicit that it asserts the disclosure is REFERENCED,
-- never that the sentence is TRUE. Shipping a corrected date would re-arm the
-- same trap facing the other way (the feed can go dark again). So the block now
-- carries the provenance the surface needs to decide, and the surface reads it.
--
-- `age_hours` is computed SERVER-side on purpose: the client must not read a
-- clock during render (React #418 hydration), so the freshness decision arrives
-- as a prop.
--
-- THREE STATES, not two. `newest_ingested_at`/`age_hours` are NULL when the
-- filtered set is empty -- an unknown age is published as NULL, never as 0, so
-- a genuinely empty book cannot read as a fresh one.
--
-- Body is the live definition (md5 c7d8662241af1da70c03332ca8b46535, read
-- immediately before this replace) with ONLY Section 2 extended -- today's
-- `candy` arm from another session is carried through untouched.
-- ─────────────────────────────────────────────────────────────────────────────
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
