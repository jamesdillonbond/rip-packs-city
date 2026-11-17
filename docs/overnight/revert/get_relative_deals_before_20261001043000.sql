-- REVERT body for supabase/migrations/20261001043000_audit_20260930_relative_deals_one_row_per_listing_with_its_ids.sql
-- The live public.get_relative_deals before that migration (prosrc md5 cb087340f94c1d9cf30e6a9d3c9bf1be),
-- captured from pg_get_functiondef on 2026-09-30 ~10:55 PM PT. It was never in a migration file.
-- ⚠ This body joins the whole fmv_snapshots HISTORY (one listing repeated per snapshot) — re-applying it
-- re-introduces that defect. ACL is preserved by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.get_relative_deals(p_collection_id uuid, p_min_discount numeric DEFAULT 15, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH raw AS (
    SELECT COALESCE(e.tier::text, 'UNKNOWN') AS tier, cl.ask_price,
      cl.player_name, e.set_name, e.id AS edition_id,
      cl.serial_number, cl.buy_url
    FROM cached_listings cl
    JOIN editions e ON e.collection_id = cl.collection_id
      AND (e.external_id = cl.moment_id
        OR (normalize_name(e.player_name) = normalize_name(cl.player_name)
            AND normalize_name(e.set_name) = normalize_name(cl.set_name)))
    WHERE cl.collection_id = p_collection_id
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
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb) FROM (
    SELECT r.player_name, r.set_name, r.tier,
      r.ask_price::numeric, ROUND(ts.median_price, 2) AS tier_median,
      ROUND((1 - r.ask_price::numeric / ts.median_price) * 100) AS discount_pct,
      f.fmv_usd, f.confidence::text AS confidence,
      r.serial_number, r.buy_url
    FROM raw r
    JOIN tier_stats ts ON ts.tier = r.tier
    LEFT JOIN fmv_snapshots f ON f.edition_id = r.edition_id
    WHERE r.ask_price::numeric < ts.median_price * (1 - p_min_discount / 100.0)
    ORDER BY discount_pct DESC
    LIMIT p_limit
  ) d;
$function$;
