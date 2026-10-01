-- audit_20260930 — get_relative_deals returns ONE row per listing, with the ids a click needs.
--
-- 🚨 MEASURED ~9:45 PM PT 2026-09-30: the Golazos fallback board (the Sniper tab's "relative deals"
-- table, shown when the sniper feed is empty on Golazos / UFC) returned 50 rows that were ALL THE SAME
-- LISTING — Joaquín, Aficionados #10645, $0.40 — repeated once per historical fmv_snapshots row, with
-- eight different "FMV"s from $0.21 to $143.75. Cause: `LEFT JOIN fmv_snapshots f ON f.edition_id = …`
-- with no latest-row filter joins the whole snapshot HISTORY. The edition join (`external_id = moment_id
-- OR name match`) can fan out too.
--
-- THE FIX
--   · one row per listing (DISTINCT ON cached_listings.id, preferring the exact external_id match);
--   · the LATEST snapshot only (LATERAL … ORDER BY computed_at DESC LIMIT 1, collection-scoped);
--   · two new output keys for click attribution (audit_20260930 outbound clicks): `edition_key`
--     (editions.external_id) and `nft_id` (cached_listings.flow_id, the on-chain moment id).
-- Callers: /api/relative-deals only (SniperClient fallback). Signature, volatility, SECURITY DEFINER,
-- search_path and ACL unchanged.
--
-- anon-exec: unchanged (get_relative_deals) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false authenticated=false.
--
-- REVERT: re-apply the previous body (live prosrc md5 cb087340f94c1d9cf30e6a9d3c9bf1be, captured in
-- docs/overnight/ledger.md 2026-09-30) — it was never in a migration file.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_relative_deals' AND pronamespace = 'public'::regnamespace) <> 'cb087340f94c1d9cf30e6a9d3c9bf1be' THEN
    RAISE EXCEPTION 'get_relative_deals live body is not the one this migration was built from — re-read before a full-body write';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.get_relative_deals(p_collection_id uuid, p_min_discount numeric DEFAULT 15, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH raw AS (
    -- One row per LISTING. The OR join can match several editions; the exact
    -- external_id match wins, then the lowest edition id for determinism.
    SELECT DISTINCT ON (cl.id)
      COALESCE(e.tier::text, 'UNKNOWN') AS tier, cl.ask_price,
      cl.player_name, e.set_name, e.id AS edition_id, e.external_id AS edition_key,
      cl.serial_number, cl.buy_url, NULLIF(cl.flow_id, '') AS nft_id
    FROM cached_listings cl
    JOIN editions e ON e.collection_id = cl.collection_id
      AND (e.external_id = cl.moment_id
        OR (normalize_name(e.player_name) = normalize_name(cl.player_name)
            AND normalize_name(e.set_name) = normalize_name(cl.set_name)))
    WHERE cl.collection_id = p_collection_id
    ORDER BY cl.id, (e.external_id = cl.moment_id) DESC, e.id
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
      r.serial_number, r.buy_url, r.edition_key, r.nft_id
    FROM raw r
    JOIN tier_stats ts ON ts.tier = r.tier
    -- The LATEST snapshot, not the history (the history multiplied every row).
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
        FROM fmv_snapshots fs
       WHERE fs.collection_id = p_collection_id AND fs.edition_id = r.edition_id
       ORDER BY fs.computed_at DESC
       LIMIT 1
    ) f ON true
    WHERE r.ask_price::numeric < ts.median_price * (1 - p_min_discount / 100.0)
    ORDER BY discount_pct DESC
    LIMIT p_limit
  ) d;
$function$;
