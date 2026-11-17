-- audit_20261018 — get_tier_pricing_benchmarks reads the ON-CHAIN book (cached_listings_v2).
--
-- WHY. The tier benchmarks beside the Golazos Sniper's relative-deals board
-- (/api/tier-pricing-benchmarks, Golazos + UFC only) read v1 `cached_listings`,
-- which for Golazos is Flowty's book alone (100 rows on 2026-10-18 against 4,286
-- open on-chain asks). The board itself moved to v2 today (20261018215244), so
-- the sidebar would have priced tiers from a different, much smaller book than
-- the deals ranked against it.
--
-- WHAT CHANGES. Asks come from cached_listings_v2 (open, priced, unexpired,
-- edition-keyed, not Flowty), joined to editions on v2's edition_id, which drops the
-- per-pair normalize_name OR join. Tier stats, the 100x-floor cap, the output
-- shape, SECURITY DEFINER, search_path and ACL are unchanged.
--
-- This function had NO migration in the repo (created outside it); the live
-- body (md5(prosrc) d2b685859d9edc13976b8d692eff99ab) is recorded below for revert.
-- anon-exec: unchanged (get_tier_pricing_benchmarks) — CREATE OR REPLACE of an existing fn; ACL preserved (service_role only), checked below.
--
-- REVERT (the live body before this migration, verbatim):
--   CREATE OR REPLACE FUNCTION public.get_tier_pricing_benchmarks(p_collection_id uuid)
--    RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
--   AS $function$
--     WITH raw AS (
--       SELECT COALESCE(e.tier::text, 'UNKNOWN') AS tier, cl.ask_price
--       FROM cached_listings cl
--       JOIN editions e ON e.collection_id = cl.collection_id
--         AND (e.external_id = cl.moment_id
--           OR (normalize_name(e.player_name) = normalize_name(cl.player_name)
--               AND normalize_name(e.set_name) = normalize_name(cl.set_name)))
--       WHERE cl.collection_id = p_collection_id
--     ),
--     (tier_floors / filtered / final SELECT identical to the body below)
--   $function$;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_tier_pricing_benchmarks' AND pronamespace = 'public'::regnamespace) <> 'd2b685859d9edc13976b8d692eff99ab' THEN
    RAISE EXCEPTION 'get_tier_pricing_benchmarks live body is not the one this migration was built from — re-read before a full-body write';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.get_tier_pricing_benchmarks(p_collection_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- 2026-10-18: the on-chain book (cached_listings_v2), not Flowty's v1 cache.
  WITH raw AS (
    SELECT COALESCE(e.tier::text, 'UNKNOWN') AS tier, cl.price_usd AS ask_price
    FROM cached_listings_v2 cl
    JOIN editions e ON e.id = cl.edition_id AND e.collection_id = cl.collection_id
    WHERE cl.collection_id = p_collection_id
      AND cl.completed_at IS NULL
      AND cl.price_usd > 0
      AND cl.edition_id IS NOT NULL
      AND cl.source <> 'flowty'
      AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
  ),
  tier_floors AS (
    SELECT tier, MIN(ask_price) AS floor_price
    FROM raw GROUP BY tier
  ),
  filtered AS (
    SELECT r.tier, r.ask_price
    FROM raw r
    JOIN tier_floors tf ON tf.tier = r.tier
    WHERE r.ask_price <= tf.floor_price * 100  -- cap at 100x floor
  )
  SELECT COALESCE(jsonb_object_agg(tier, stats), '{}'::jsonb)
  FROM (
    SELECT tier,
      jsonb_build_object(
        'count', count(*),
        'floor', ROUND(MIN(ask_price)::numeric, 2),
        'median', ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ask_price)::numeric, 2),
        'p25', ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ask_price)::numeric, 2),
        'avg', ROUND(AVG(ask_price)::numeric, 2),
        'p75', ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ask_price)::numeric, 2)
      ) AS stats
    FROM filtered
    GROUP BY tier
  ) sub;
$function$;

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.get_tier_pricing_benchmarks(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_tier_pricing_benchmarks(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_tier_pricing_benchmarks became executable by anon/authenticated';
  END IF;
END $post$;
