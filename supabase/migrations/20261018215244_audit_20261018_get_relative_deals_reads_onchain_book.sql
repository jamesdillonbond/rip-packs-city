-- audit_20261018 — get_relative_deals reads the ON-CHAIN book (cached_listings_v2), not Flowty's v1 cache.
--
-- WHY. The Golazos Sniper's tier-median "relative deals" (its fallback when the
-- FMV feed is ask-circular) read v1 `cached_listings`, which for Golazos holds
-- only Flowty's book: 100 rows on 2026-10-18 against 4,286 open on-chain asks.
-- Its buy_url values were flowty.io links, which are dead. On the day Flowty's
-- API goes dark the board would have gone empty and read "No relative deals
-- right now. Benchmark data may be too thin."
--
-- WHAT CHANGES. Listings come from cached_listings_v2 (open, priced, unexpired,
-- edition-keyed). v2 carries edition_id, so the name-normalising two-leg join is
-- gone. buy_url is NULL; the client builds the native moment link from nft_id
-- (= flow_id), as resolveListingUrl already does. serial_number comes from
-- wallet_moments_cache by (collection_id, moment_id); that covers 335 of 4,286
-- today, and an unknown serial stays NULL (the client hides it). The FMV and serial lookups
-- now run AFTER the LIMIT (they do not affect the order): the prototype with
-- them before the LIMIT ran them 1,135 times (313 ms, 12.8k buffers).
-- Tier-median maths, thresholds, output keys, signature, volatility, SECURITY
-- DEFINER, search_path and ACL are unchanged. The only callers are Golazos and
-- UFC (UFC's v2 book is empty, as its v1 was). Ties break on ask then nft_id.
--
-- Built from live prosrc md5 362040ab6ffc7c2d101cf7dc6e404cb4 (= the 20261011194733 body,
-- whitespace-normalised md5 ff1a85a92a4547e4e8559c79142e7f2b); the guard requires it.
-- anon-exec: unchanged (get_relative_deals) — CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- REVERT: re-apply the CREATE OR REPLACE body of 20261011194733_audit_20261011_get_relative_deals_normalize_once_two_hash_legs.sql.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_relative_deals' AND pronamespace = 'public'::regnamespace) <> '362040ab6ffc7c2d101cf7dc6e404cb4' THEN
    RAISE EXCEPTION 'get_relative_deals live body is not the one this migration was built from — re-read before a full-body write';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.get_relative_deals(p_collection_id uuid, p_min_discount numeric DEFAULT 15, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- 2026-10-18: the on-chain book (cached_listings_v2), not Flowty's v1 cache.
  WITH raw AS MATERIALIZED (
    SELECT COALESCE(e.tier::text, 'UNKNOWN') AS tier, cl.price_usd AS ask_price,
           e.player_name, e.set_name, e.id AS edition_id, e.external_id AS edition_key,
           cl.flow_id::text AS nft_id
      FROM cached_listings_v2 cl
      JOIN editions e ON e.id = cl.edition_id AND e.collection_id = cl.collection_id
     WHERE cl.collection_id = p_collection_id
       AND cl.completed_at IS NULL
       AND cl.price_usd > 0
       AND cl.edition_id IS NOT NULL
       AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
  ),
  tier_floors AS (
    SELECT tier, MIN(ask_price) AS floor_price
    FROM raw GROUP BY tier
  ),
  tier_stats AS (
    SELECT r.tier,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.ask_price)::numeric AS median_price,
      COUNT(*) AS listing_count
    FROM raw r
    JOIN tier_floors tf ON tf.tier = r.tier
    WHERE r.ask_price <= tf.floor_price * 100
    GROUP BY r.tier
    HAVING COUNT(*) >= 2
  ),
  top AS (
    SELECT r.player_name, r.set_name, r.tier, r.ask_price::numeric AS ask_price,
      ROUND(ts.median_price, 2) AS tier_median,
      ROUND((1 - r.ask_price::numeric / ts.median_price) * 100) AS discount_pct,
      r.edition_id, r.edition_key, r.nft_id
    FROM raw r
    JOIN tier_stats ts ON ts.tier = r.tier
    WHERE r.ask_price::numeric < ts.median_price * (1 - p_min_discount / 100.0)
    ORDER BY discount_pct DESC, r.ask_price, r.nft_id
    LIMIT p_limit
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.discount_pct DESC, d.ask_price, d.nft_id), '[]'::jsonb) FROM (
    SELECT t.player_name, t.set_name, t.tier, t.ask_price, t.tier_median, t.discount_pct,
      f.fmv_usd, f.confidence::text AS confidence,
      s.serial_number, NULL::text AS buy_url, t.edition_key, t.nft_id
    FROM top t
    -- The LATEST snapshot, not the history (the history multiplied every row).
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
        FROM fmv_snapshots fs
       WHERE fs.collection_id = p_collection_id AND fs.edition_id = t.edition_id
       ORDER BY fs.computed_at DESC
       LIMIT 1
    ) f ON true
    -- A serial is an NFT attribute; any wmc row for this moment carries it. A
    -- moment_id is unique only within a collection, so the read is scoped.
    LEFT JOIN LATERAL (
      SELECT w.serial_number
        FROM wallet_moments_cache w
       WHERE w.collection_id = p_collection_id AND w.moment_id = t.nft_id
         AND w.serial_number IS NOT NULL
       LIMIT 1
    ) s ON true
  ) d;
$function$;

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.get_relative_deals(uuid,numeric,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_relative_deals(uuid,numeric,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_relative_deals became executable by anon/authenticated';
  END IF;
END $post$;
