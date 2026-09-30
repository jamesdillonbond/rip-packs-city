-- audit_20260929_get_allday_sniper_deals_takes_a_player
--
-- ── THE DEFECT, MEASURED ─────────────────────────────────────────────────────
-- The All Day Sniper's PLAYER search filtered the finished board: this function
-- returns the top 200 listings for the chosen sort, and /api/sniper-feed then
-- kept the rows whose player name matched. A player outside those 200 was
-- invisible — "Mahomes" answered ONE deal on 2026-09-29 (~6:25 PM PT). The Top
-- Shot leg had the same shape and now passes p_player to its own RPC; this
-- function had no player parameter to pass.
--
-- ── THE CHANGE ───────────────────────────────────────────────────────────────
-- One new trailing parameter, p_player text DEFAULT NULL: a case-insensitive
-- substring of editions.player_name, typed LIKE wildcards escaped. NULL or blank
-- keeps today's behaviour exactly. The body is otherwise the live one, byte for
-- byte (md5 of the whitespace-normalised prosrc = 7e906331f3c2cd24fa02f370d2c6ac23
-- both live and in 20260913231500, verified before this file was written).
--
-- A new signature needs DROP + CREATE: a CREATE OR REPLACE with an extra
-- parameter would add a SECOND overload, and PostgREST cannot pick between two
-- that both accept the six named arguments its callers send (the route and
-- workers/rpc-mcp-proxy — both named-argument calls, both unaffected by the
-- new defaulted parameter). No view or function depends on it (pg_depend: none).
--
-- anon-exec: get_allday_sniper_deals -- revoked below (REVOKE FROM PUBLIC, anon, authenticated; service_role + postgres only, as before: has_function_privilege anon=false, authenticated=false)

DROP FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer);

CREATE FUNCTION public.get_allday_sniper_deals(p_min_discount numeric DEFAULT 0, p_max_price numeric DEFAULT 0, p_rarity text DEFAULT 'all'::text, p_team text DEFAULT 'all'::text, p_sort_by text DEFAULT 'discount_desc'::text, p_limit integer DEFAULT 50, p_player text DEFAULT NULL::text)
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

REVOKE ALL ON FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer, text) TO service_role, postgres;

COMMENT ON FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer, text) IS
'AllDay sniper feed. Rewritten 2026-05-17 to read from cached_listings_v2 (the active 30K-row listings cache) instead of the legacy cached_listings table which had drifted to 19 rows. Uses LATERAL latest-FMV subquery for partition-prunable read, adds COALESCE wrappers for NULL-safe filter args. buy_url synthesized from listing_resource_id since v2 doesn''t store it. 2026-09-13: body now runs via RETURN QUERY EXECUTE … USING (plpgsql) so it is planned with the parameter VALUES — the LANGUAGE sql form planned every call as the generic shape at 6.5× the buffers (migration 20260913231500). 2026-09-29: p_player (substring of editions.player_name, LIKE wildcards escaped) so a player search reads every listing of that player, not the top 200 of the whole board (migration 20260930012900).';
