-- audit_20260925_fmv_from_cached_listings_prices_only_fresh_listings
--
-- Trevor 2026-09-25: "do it" — after being told Flowty will turn its endpoints off soon.
--
-- WHY. fmv_from_cached_listings (called every 20 min by the Golazos, UFC and All Day
-- listing-cache routes; All Day returns 0 since 20260923205831) prices from the
-- Flowty-fed legacy cached_listings. When a sweep fails, the route deliberately
-- PRESERVES the prior cache and still calls this function, which re-inserted every
-- frozen listing's price with computed_at = NOW(). With Flowty gone that is a dead
-- marketplace's last asks re-stamped as fresh FMV every 20 minutes until the daily
-- 48 h purge (purge-stale-listings, 04:00 UTC) empties the cache — up to ~3 days.
-- Measured 2026-09-25: the lane's current output is 66 Golazos editions (of 575).
--
-- WHAT CHANGES. Both the DELETE and the INSERT consider only listings with
-- cached_at within 2 hours. Today every Flowty row is minutes old (the Golazos
-- book was fetched in one sweep at 8:06 AM PT), so the output is unchanged; the
-- bound only acts once sweeps stop landing. Everything else is byte-identical to
-- 20260923205831.
--
-- REVERT: re-apply the function body from
-- 20260923205831_audit_20260923_fmv_from_cached_listings_skips_allday_and_caps_at_ask.sql.

-- anon-exec: unchanged (fmv_from_cached_listings) — CREATE OR REPLACE of an existing SECURITY DEFINER fn; ACL preserved, has_function_privilege('anon') = false and proacl = {postgres, service_role} read 09-25 8:45 AM PT.
CREATE OR REPLACE FUNCTION public.fmv_from_cached_listings(p_collection_id uuid, p_algo_version text DEFAULT 'ask_only_v2'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  rows_inserted integer := 0;
  ask_price_ceiling numeric := 5000;
  -- 2026-09-25: only listings the cache fetched within this window are priced. When
  -- Flowty's API stops answering, every listing-cache sweep fails and the route keeps
  -- its prior cache (right for a blip), so without this bound the lane re-stamped
  -- those frozen asks as fresh ASK_ONLY rows (computed_at = NOW()) every 20 minutes
  -- until the daily 48 h purge emptied the cache. A stale listing now neither deletes
  -- nor re-writes: the edition keeps its last row, whose computed_at ages honestly.
  -- 2 h = six missed 20-minute ticks, so a short upstream blip changes nothing.
  listing_max_age interval := interval '2 hours';
BEGIN
  -- 2026-09-23: NFL All Day is NOT priced here. Its ASK_ONLY lane is owned by
  -- fmv-recalc Step 5d and refresh_allday_ask_fmv_from_listings, both of which read
  -- the on-chain listings (cached_listings_v2) through the ghost filter
  -- (allday_listings_sold_after_listing). The Flowty cache this function reads held
  -- mostly $1,000,000 troll asks for All Day, and publishing Flowty's valuation over
  -- them put FMVs 20x above a live buy-it-now (Jer'Zhan Newton $60.39 vs a $3 ask) and
  -- re-created prices the ghost fix had just retired.
  IF p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN
    RETURN 0;
  END IF;

  -- Targeted DELETE: only this lane's own ASK_ONLY rows. It used to delete LOW rows
  -- too, which let a Flowty valuation replace a sales-derived LOW price.
  DELETE FROM fmv_snapshots fs
  WHERE fs.collection_id = p_collection_id
    AND fs.confidence = 'ASK_ONLY'::fmv_confidence
    AND fs.edition_id IN (
      SELECT DISTINCT e.id
      FROM cached_listings cl
      JOIN editions e ON e.collection_id = p_collection_id
        AND (
          (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
          OR
          (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
           AND normalize_name(e.player_name) = normalize_name(cl.player_name)
           AND normalize_name(e.set_name) = normalize_name(cl.set_name))
        )
      WHERE cl.collection_id = p_collection_id
        AND cl.ask_price > 0
        AND cl.cached_at > NOW() - listing_max_age
        AND NOT EXISTS (
          SELECT 1 FROM fmv_snapshots f2
          WHERE f2.edition_id = e.id
            AND f2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence)
        )
    );

  -- INSERT new ASK_ONLY rows. The valuation is capped at the cheapest ask under the
  -- sanity ceiling (the ask-ceiling rule: a base FMV above buy-it-now is a confident
  -- wrong number), and an ask above the ceiling is never recorded as a floor.
  INSERT INTO fmv_snapshots (
    edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
    confidence, listing_count, algo_version, computed_at,
    liquidity_rating, top_shot_ask, flowty_ask, cross_market_ask
  )
  SELECT
    e.id AS edition_id,
    p_collection_id,
    -- Primary: avg of cl.fmv when present; fallback: MIN(ask_price) under the ceiling.
    -- LEAST ignores NULLs, so an ask above the ceiling simply does not cap.
    LEAST(
      COALESCE(
        NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
        CASE
          WHEN MIN(cl.ask_price) <= ask_price_ceiling
          THEN ROUND(MIN(cl.ask_price), 2)
          ELSE NULL  -- no FMV row produced — better silence than $1M garbage
        END
      ),
      CASE
        WHEN MIN(cl.ask_price) <= ask_price_ceiling
        THEN ROUND(MIN(cl.ask_price), 2)
        ELSE NULL
      END
    ) AS fmv_usd,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS floor_price_usd,
    NULL AS wap_usd,
    'ASK_ONLY'::fmv_confidence AS confidence,
    COUNT(cl.id)::int AS listing_count,
    p_algo_version,
    NOW(),
    1 AS liquidity_rating,
    NULL AS top_shot_ask,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS flowty_ask,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS cross_market_ask
  FROM cached_listings cl
  JOIN editions e ON e.collection_id = p_collection_id
    AND (
      (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
      OR
      (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
       AND normalize_name(e.player_name) = normalize_name(cl.player_name)
       AND normalize_name(e.set_name) = normalize_name(cl.set_name))
    )
  WHERE cl.collection_id = p_collection_id
    AND cl.ask_price > 0
    AND cl.cached_at > NOW() - listing_max_age
    AND NOT EXISTS (
      SELECT 1 FROM fmv_snapshots fs2
      WHERE fs2.edition_id = e.id
        AND fs2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence)
    )
  GROUP BY e.id
  -- HAVING clause excludes editions where the resulting fmv_usd would be NULL
  HAVING COALESCE(
    NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
    CASE
      WHEN MIN(cl.ask_price) <= ask_price_ceiling
      THEN ROUND(MIN(cl.ask_price), 2)
      ELSE NULL
    END
  ) IS NOT NULL;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  RETURN rows_inserted;
END;
$function$;
