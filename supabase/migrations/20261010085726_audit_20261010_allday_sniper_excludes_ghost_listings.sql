-- audit_20261010_allday_sniper_excludes_ghost_listings
--
-- 2026-10-10 (~1:55 AM PT, Claude Code cloud). get_allday_sniper_deals read
-- every cached_listings_v2 row with completed_at IS NULL. A listing closes only
-- on its OWN ListingCompleted event, so a moment that sold through a different
-- listing leaves the original "open" forever — the ghost set that
-- allday_listings_sold_after_listing (refreshed every 15 min) already names and
-- allday_edition_floor_ask already excludes (20260922205752). The sniper did
-- not: MEASURED 10-10 1:50 AM PT, 50 of the top 50 All Day sniper deals were
-- ghosts (stale, cheap asks rank as the deepest "discounts"), 3,522 of 32,129
-- open All Day rows.
--
-- Change: one anti-join in open_l on the ghost set's PK (listing_resource_id,
-- source). Nothing else in the body moves; the base is the 20260930013059 body,
-- verified byte-identical to production (md5(prosrc) 01b31c7d4755c1c7f4f96f5ae48590f8).
-- Cost, EXPLAIN (ANALYZE, BUFFERS) of the inner query at the default arguments,
-- back to back: 15,626 → 16,884 shared buffers (+8 %, the 3,522-row ghost index),
-- 195 → 155 ms.
--
-- anon-exec: unchanged (get_allday_sniper_deals) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
--
-- Revert: re-apply 20260930013059's CREATE body as CREATE OR REPLACE (drop the NOT EXISTS block).

CREATE OR REPLACE FUNCTION public.get_allday_sniper_deals(p_min_discount numeric DEFAULT 0, p_max_price numeric DEFAULT 0, p_rarity text DEFAULT 'all'::text, p_team text DEFAULT 'all'::text, p_sort_by text DEFAULT 'discount_desc'::text, p_limit integer DEFAULT 50, p_player text DEFAULT NULL::text)
 RETURNS TABLE(flow_id text, moment_id text, player_name text, team_name text, set_name text, series_name text, tier text, serial_number integer, circulation_count integer, ask_price numeric, fmv_usd numeric, discount_pct numeric, confidence text, buy_url text, thumbnail_url text, listing_resource_id text, source text, listed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY EXECUTE $q$
SELECT q.flow_id::text, q.moment_id::text, q.player_name::text, q.team_name::text, q.set_name::text, q.series_name::text, q.tier::text, q.serial_number::integer, q.circulation_count::integer, q.ask_price::numeric, q.fmv_usd::numeric, q.discount_pct::numeric, q.confidence::text, q.buy_url::text, q.thumbnail_url::text, q.listing_resource_id::text, q.source::text, q.listed_at::timestamptz FROM (
  WITH open_l AS MATERIALIZED (
    SELECT cl.listing_resource_id, cl.source, cl.flow_id, cl.edition_id, cl.collection_id, cl.price_usd, cl.listed_at
    FROM cached_listings_v2 cl
    WHERE cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND cl.completed_at IS NULL
      AND (COALESCE($2, 0) = 0 OR cl.price_usd <= $2)
      AND NOT EXISTS (
        SELECT 1 FROM allday_listings_sold_after_listing g
        WHERE g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source
      )
  ),
  ranked AS (
    SELECT
      cl.flow_id, cl.edition_id, cl.collection_id, cl.price_usd, cl.listed_at, cl.listing_resource_id, cl.source,
      e.external_id, e.player_name, e.team_name, e.set_name, e.series, e.tier, e.circulation_count, e.thumbnail_url,
      l.fmv_usd, l.confidence,
      ROUND(((l.fmv_usd - cl.price_usd) / NULLIF(l.fmv_usd, 0)) * 100, 1) AS discount_pct
    FROM open_l cl
    JOIN edition_fmv_current l
      ON l.edition_id = cl.edition_id
     AND l.fmv_usd IS NOT NULL
     AND l.computed_at > now() - interval '90 days'
    JOIN editions e ON e.id = cl.edition_id
    WHERE (COALESCE($3, 'all') = 'all' OR UPPER(e.tier::text) = UPPER($3))
      AND (COALESCE($4, 'all') = 'all' OR e.team_name ILIKE $4)
      AND (COALESCE(btrim($7), '') = ''
           OR e.player_name ILIKE '%' || replace(replace(replace(btrim($7), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (
        COALESCE($1, 0) = 0
        OR ROUND(((l.fmv_usd - cl.price_usd) / NULLIF(l.fmv_usd, 0)) * 100, 1) >= $1
      )
    ORDER BY
      CASE WHEN $5 = 'price_asc'  THEN cl.price_usd END ASC  NULLS LAST,
      CASE WHEN $5 = 'price_desc' THEN cl.price_usd END DESC NULLS LAST,
      CASE WHEN $5 = 'fmv_desc'   THEN l.fmv_usd   END DESC NULLS LAST,
      ROUND(((l.fmv_usd - cl.price_usd) / NULLIF(l.fmv_usd, 0)) * 100, 1) DESC NULLS LAST,
      cl.price_usd ASC
    LIMIT COALESCE($6, 50)
  )
  SELECT
    r.flow_id::text                                          AS flow_id,
    r.external_id                                            AS moment_id,
    r.player_name                                            AS player_name,
    r.team_name                                              AS team_name,
    r.set_name                                               AS set_name,
    r.series::text                                           AS series_name,
    r.tier::text                                             AS tier,
    wmc.serial_number                                        AS serial_number,
    r.circulation_count                                      AS circulation_count,
    r.price_usd                                              AS ask_price,
    r.fmv_usd                                                AS fmv_usd,
    r.discount_pct                                           AS discount_pct,
    r.confidence::text                                       AS confidence,
    'https://nflallday.com/listing/' || r.listing_resource_id::text AS buy_url,
    r.thumbnail_url                                          AS thumbnail_url,
    r.listing_resource_id::text                              AS listing_resource_id,
    r.source                                                 AS source,
    r.listed_at                                              AS listed_at
  FROM ranked r
  LEFT JOIN LATERAL (
    SELECT w.serial_number
    FROM wallet_moments_cache w
    WHERE w.moment_id = r.flow_id::text
      AND w.collection_id = r.collection_id
    LIMIT 1
  ) wmc ON true
  ORDER BY
    CASE WHEN $5 = 'price_asc'  THEN r.price_usd END ASC  NULLS LAST,
    CASE WHEN $5 = 'price_desc' THEN r.price_usd END DESC NULLS LAST,
    CASE WHEN $5 = 'fmv_desc'   THEN r.fmv_usd   END DESC NULLS LAST,
    r.discount_pct DESC NULLS LAST,
    r.price_usd ASC
) q
$q$ USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit, p_player;
END;
$function$;
