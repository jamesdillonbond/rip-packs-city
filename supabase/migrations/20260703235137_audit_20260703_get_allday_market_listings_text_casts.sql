-- Follow-up to the AllDay pushdown rewrite: plpgsql RETURN QUERY EXECUTE requires
-- exact output types, and editions.external_id (+ some columns) are varchar. The old
-- LANGUAGE sql function coerced varchar->text implicitly; add explicit ::text casts so
-- the dynamic query matches the RETURNS TABLE signature. No logic/order/filter change.
-- Verified: full result set (22,022 rows) is md5-identical to the original query def.
CREATE OR REPLACE FUNCTION public.get_allday_market_listings(
  p_min_discount numeric DEFAULT 0,
  p_max_price numeric DEFAULT 0,
  p_rarity text DEFAULT 'all'::text,
  p_team text DEFAULT 'all'::text,
  p_sort_by text DEFAULT 'listed_desc'::text,
  p_limit integer DEFAULT 500
)
 RETURNS TABLE(flow_id text, moment_id text, player_name text, team_name text, set_name text, series_name text, tier text, serial_number integer, circulation_count integer, ask_price numeric, fmv_usd numeric, discount_pct numeric, confidence text, buy_url text, thumbnail_url text, listing_resource_id text, source text, listed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rarity   text := COALESCE(p_rarity, 'all');
  v_team     text := COALESCE(p_team, 'all');
  v_maxprice text := COALESCE(p_max_price, 0)::text;
  v_limit    text := COALESCE(p_limit, 500)::text;
  v_order    text;
  v_disc     text := '';
  v_sql      text;
BEGIN
  v_order := CASE p_sort_by
    WHEN 'price_asc'     THEN 'cl.price_usd ASC NULLS LAST, cl.listed_at DESC NULLS LAST'
    WHEN 'price_desc'    THEN 'cl.price_usd DESC NULLS LAST, cl.listed_at DESC NULLS LAST'
    WHEN 'fmv_desc'      THEN 'fs.fmv_usd DESC NULLS LAST, cl.listed_at DESC NULLS LAST'
    WHEN 'discount_desc' THEN '(CASE WHEN fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0 THEN ROUND(((fs.fmv_usd - cl.price_usd) / fs.fmv_usd) * 100, 1) END) DESC NULLS LAST, cl.listed_at DESC NULLS LAST'
    ELSE 'cl.listed_at DESC NULLS LAST'
  END;

  IF COALESCE(p_min_discount, 0) > 0 THEN
    v_disc := format(' AND (fs.fmv_usd IS NOT NULL AND ROUND(((fs.fmv_usd - cl.price_usd) / NULLIF(fs.fmv_usd, 0)) * 100, 1) >= %s)', p_min_discount::text);
  END IF;

  v_sql := format($fmt$
    SELECT
      cl.flow_id::text,
      e.external_id::text,
      e.player_name::text,
      e.team_name::text,
      e.set_name::text,
      e.series::text,
      e.tier::text,
      wmc.serial_number,
      e.circulation_count,
      cl.price_usd,
      fs.fmv_usd,
      CASE WHEN fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0
           THEN ROUND(((fs.fmv_usd - cl.price_usd) / fs.fmv_usd) * 100, 1)
           ELSE NULL END,
      COALESCE(fs.confidence::text, 'ASK_ONLY'),
      ('https://nflallday.com/listing/' || cl.listing_resource_id::text)::text,
      e.thumbnail_url::text,
      cl.listing_resource_id::text,
      cl.source::text,
      cl.listed_at
    FROM cached_listings_v2 cl
    JOIN editions e ON e.id = cl.edition_id
    LEFT JOIN LATERAL (
      SELECT w.serial_number FROM wallet_moments_cache w
      WHERE w.moment_id = cl.flow_id::text AND w.collection_id = cl.collection_id
      LIMIT 1
    ) wmc ON true
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.confidence FROM fmv_snapshots s
      WHERE s.edition_id = e.id AND s.fmv_usd IS NOT NULL
        AND s.computed_at > now() - interval '90 days'
      ORDER BY s.computed_at DESC LIMIT 1
    ) fs ON true
    WHERE cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND cl.completed_at IS NULL
      AND cl.source <> 'flowty'
      AND (%L = 'all' OR UPPER(e.tier::text) = UPPER(%L))
      AND (%L = 'all' OR e.team_name ILIKE %L)
      AND (%s = 0 OR cl.price_usd <= %s)
      %s
    ORDER BY %s
    LIMIT %s
  $fmt$, v_rarity, v_rarity, v_team, v_team, v_maxprice, v_maxprice, v_disc, v_order, v_limit);

  RETURN QUERY EXECUTE v_sql;
END;
$function$;
