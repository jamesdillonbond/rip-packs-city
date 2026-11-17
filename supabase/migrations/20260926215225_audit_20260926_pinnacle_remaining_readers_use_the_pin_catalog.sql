-- audit_20260926_pinnacle_remaining_readers_use_the_pin_catalog
--
-- WHY. The residue of known-issues #150: eleven functions still read
-- pinnacle_editions — SET-LEVEL legacy keys, each naming ONE character and ONE
-- franchise for a key that can span several pins. Each was measured 2026-09-26;
-- the eight below were WRONG where a reader can see it:
--   * Market analytics (pinnacle_top_editions / _top_sales / _tier_analytics /
--     _daily_tier_volume; /api/market-analytics on the Pinnacle Analytics page):
--     sales joined to the key's one character — 3,711 of 4,928 30-day sales
--     carried the WRONG character (every Cats & Dogs Vol.1 pin read "Lady", so
--     Pongo/Duchess/Pluto/Figaro sales ranked under her).
--   * get_pinnacle_franchise_breakdown (/api/pinnacle-wallet): 3,423 of 41,264
--     held pins filed under the wrong franchise.
--   * get_edition_detail (concierge + entity API; the edition PAGE 308s every
--     Pinnacle URL to the pin page first): a render_id returned NULL, and a
--     multi-character key named one character for the whole set.
--   * get_platform_stats (public /api/platform-stats): Pinnacle "editions" 594
--     (keys) for 2,732 pins, coverage from a legacy ask column, and an FMV age
--     of 102,698 minutes (~71 days) from that column's newest write.
--   * analytics_sets_summary (/analytics sets dashboard): 594 "editions".
-- The other three were measured and NOT changed: get_user_top_owned_moments
-- reads pinnacle_editions only as an image fallback reached by 0 of 41,264
-- Pinnacle wmc rows (image_url is always set); collection_readiness asks only
-- "any rows?" (true from either table); get_pinnacle_set_progress has NO caller
-- (no repo code, cron, function or view references it).
--
-- WHAT. Each reads pinnacle_catalog (one row per PIN) — sales by
-- pinnacle_sales.render_id, holdings by wallet_moments_cache.render_id, franchise
-- = franchises[1] with ™/®/© stripped; get_edition_detail answers a render_id
-- from the catalog and, for a legacy key spanning more than one character, names
-- the SET and lists the characters. Every non-Pinnacle line is byte-for-byte the
-- live body; none had repo DDL before except get_edition_detail (repo copy
-- 20260711185416 is older than live). Base prosrc md5s:
--   pinnacle_top_editions              7c762e397871135c6a36b2a6eafb2f6d
--   pinnacle_top_sales                 4f086c1f65879178fe2021dd4f59816e
--   pinnacle_tier_analytics            8e0489182b0d35b9e6d8e5f9e6bc7c43
--   pinnacle_daily_tier_volume         2722625ad9cefb8930ec023b3d19e982
--   get_pinnacle_franchise_breakdown   983cee7d7f4cf81a58863ecdccfdf8a9
--   get_edition_detail                 220123324b8b995979b60e1587fdef69
--   get_platform_stats                 e85a919a7141e4332f582da78b9cecb2
--   analytics_sets_summary             6171630df26a078fe87be90f5dd40630
--
-- REVERT: re-apply each base body (identified by the md5s above).

-- anon-exec: intentional — pinnacle_top_editions is an existing INVOKER read already executable by anon and authenticated; CREATE OR REPLACE leaves its ACL untouched, and its only caller (/api/market-analytics) uses the service role.
CREATE OR REPLACE FUNCTION public.pinnacle_top_editions(p_since timestamp with time zone DEFAULT (now() - '30 days'::interval), p_limit integer DEFAULT 10)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT
      btrim(c.character_name) AS player_name,
      btrim(c.set_name) AS set_name,
      COALESCE(c.variant, 'STANDARD') AS tier,
      c.total_minted AS circulation_count,
      c.render_id,
      count(*)::int AS sale_count,
      round(sum(s.sale_price_usd)::numeric, 2) AS volume,
      round(avg(s.sale_price_usd)::numeric, 2) AS avg_price
    FROM pinnacle_sales s
    -- 2026-09-26: the PIN each sale is of (render_id), not the set-level key's
    -- one character — which mislabelled 3,711 of 4,928 30-day sales.
    JOIN pinnacle_catalog c ON c.render_id = s.render_id
    WHERE s.sold_at >= p_since
      AND s.sale_price_usd > 0
      AND c.character_name IS NOT NULL
    GROUP BY c.render_id, c.character_name, c.set_name, c.variant, c.total_minted
    ORDER BY volume DESC, c.render_id
    LIMIT p_limit
  ) t;
$function$;

-- anon-exec: intentional — pinnacle_top_sales is an existing INVOKER read already executable by anon and authenticated; CREATE OR REPLACE leaves its ACL untouched, and its only caller (/api/market-analytics) uses the service role.
CREATE OR REPLACE FUNCTION public.pinnacle_top_sales(p_since timestamp with time zone DEFAULT (now() - '30 days'::interval), p_limit integer DEFAULT 10)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT
      s.sale_price_usd AS price_usd,
      s.sold_at,
      s.serial_number,
      COALESCE(s.source, 'pinnacle') AS marketplace,
      btrim(c.character_name) AS player_name,
      btrim(c.set_name) AS set_name,
      COALESCE(c.variant, 'STANDARD') AS tier,
      c.total_minted AS circulation_count,
      c.render_id
    FROM pinnacle_sales s
    -- 2026-09-26: the PIN each sale is of (render_id), not the set-level key's
    -- one character — which mislabelled 3,711 of 4,928 30-day sales.
    JOIN pinnacle_catalog c ON c.render_id = s.render_id
    WHERE s.sold_at >= p_since
      AND s.sale_price_usd > 0
    ORDER BY s.sale_price_usd DESC
    LIMIT p_limit
  ) t;
$function$;

-- anon-exec: intentional — pinnacle_tier_analytics is an existing INVOKER read already executable by anon and authenticated; CREATE OR REPLACE leaves its ACL untouched, and its only caller (/api/market-analytics) uses the service role.
CREATE OR REPLACE FUNCTION public.pinnacle_tier_analytics(p_since timestamp with time zone DEFAULT (now() - '30 days'::interval))
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT
      COALESCE(c.variant, 'STANDARD') AS tier,
      count(*)::int AS sale_count,
      round(sum(s.sale_price_usd)::numeric, 2) AS volume,
      round(avg(s.sale_price_usd)::numeric, 2) AS avg_price,
      round(min(s.sale_price_usd)::numeric, 2) AS min_price,
      round(max(s.sale_price_usd)::numeric, 2) AS max_price
    FROM pinnacle_sales s
    -- 2026-09-26: the PIN each sale is of (render_id), not the set-level key's
    -- one character — which mislabelled 3,711 of 4,928 30-day sales.
    JOIN pinnacle_catalog c ON c.render_id = s.render_id
    WHERE s.sold_at >= p_since
      AND s.sale_price_usd > 0
    GROUP BY c.variant
    ORDER BY volume DESC
  ) t;
$function$;

-- anon-exec: intentional — pinnacle_daily_tier_volume is an existing INVOKER read already executable by anon and authenticated; CREATE OR REPLACE leaves its ACL untouched, and its only caller (/api/market-analytics) uses the service role.
CREATE OR REPLACE FUNCTION public.pinnacle_daily_tier_volume(p_since timestamp with time zone DEFAULT (now() - '30 days'::interval))
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT
      (s.sold_at::date)::text AS date,
      COALESCE(c.variant, 'STANDARD') AS tier,
      count(*)::int AS sale_count,
      round(sum(s.sale_price_usd)::numeric, 2) AS volume,
      round(avg(s.sale_price_usd)::numeric, 2) AS avg_price
    FROM pinnacle_sales s
    -- 2026-09-26: the PIN each sale is of (render_id), not the set-level key's
    -- one character — which mislabelled 3,711 of 4,928 30-day sales.
    JOIN pinnacle_catalog c ON c.render_id = s.render_id
    WHERE s.sold_at >= p_since
      AND s.sale_price_usd > 0
    GROUP BY s.sold_at::date, c.variant
    ORDER BY date, tier
  ) t;
$function$;

-- anon-exec: intentional — get_pinnacle_franchise_breakdown is an existing INVOKER read already executable by anon and authenticated; CREATE OR REPLACE leaves its ACL untouched, and its only caller (/api/pinnacle-wallet) uses the service role.
CREATE OR REPLACE FUNCTION public.get_pinnacle_franchise_breakdown(p_wallet text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result json;
BEGIN
  SELECT COALESCE(json_agg(json_build_object(
    'franchise', franchise,
    'pin_count', cnt,
    'total_fmv', total_fmv
  ) ORDER BY total_fmv DESC NULLS LAST), '[]'::json)
  INTO result
  FROM (
    SELECT
      COALESCE(NULLIF(btrim(regexp_replace(pc.franchises[1], '[™®©]', '', 'g')), ''), 'Unknown') as franchise,
      COUNT(*)::int as cnt,
      ROUND(COALESCE(SUM(wmc.fmv_usd), 0), 2) as total_fmv
    FROM wallet_moments_cache wmc
    -- 2026-09-26: the franchise of the PIN held (wmc.render_id, set on every
    -- Pinnacle row), not the set-level key's one franchise — which filed 3,423
    -- of 41,264 held pins under the wrong franchise. ™/®/© stripped, so the name
    -- equals the franchise page's.
    LEFT JOIN pinnacle_catalog pc ON pc.render_id = wmc.render_id
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
    GROUP BY 1
  ) sub;

  RETURN result;
END;
$function$;

-- anon-exec: unchanged (get_edition_detail) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.get_edition_detail(p_collection_id uuid, p_route_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: a render_id is a PIN — answer from the render catalog.
    SELECT jsonb_build_object(
      'id',                pc.render_id,
      'source',            'pinnacle_catalog',
      'collection_id',     v_pinnacle_uuid,
      'collection_slug',   'disney_pinnacle',
      'route_slug',        pc.render_id,
      'external_id',       NULL::text,
      'legacy_edition_key', pc.legacy_edition_key,
      'name',              btrim(pc.character_name) || ' - ' || btrim(pc.set_name) || ' (' || pc.variant || ')',
      'player_name',       btrim(pc.characters[1]),
      'characters',        to_jsonb(pc.characters),
      'set_name',          btrim(pc.set_name),
      'set_slug',          regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g'),
      'tier',              pc.variant,
      'series_label',      CASE WHEN pc.series_name ~ '^[0-9]{4}$'
                                THEN public.series_display_label(p_collection_id, pc.series_name::int)
                                ELSE pc.series_name END,
      'edition_kind',      pc.edition_type,
      'circulation_count', pc.total_minted,
      'is_serialized',     pc.limited_edition,
      'is_chaser',         pc.is_chaser,
      'thumbnail_url',     pc.thumbnail_url,
      'video_url',         NULL::text,
      'team_name',         NULLIF(btrim(regexp_replace(pc.franchises[1], '[™®©]', '', 'g')), ''),
      'first_minted_at',   NULL::timestamptz,
      'fmv',               CASE
        WHEN pc.fmv_usd IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fmv_usd',         pc.fmv_usd,
          'wap_usd',         pc.fmv_wap_usd,
          'floor_usd',       pc.floor_ask,
          'confidence',      pc.fmv_confidence,
          'computed_at',     pc.fmv_computed_at,
          'sales_count_30d', pc.fmv_sales_count_30d,
          'sales_count_7d',  pc.fmv_sales_count_7d,
          'days_since_sale', pc.fmv_days_since_sale,
          'pinnacle_ask',    pc.floor_ask,
          'flowty_ask',      NULL::numeric,
          'cross_market_ask',NULL::numeric,
          'listing_count',   NULL::int,
          'offer_count',     NULL::int,
          'fmv_min',         pc.fmv_usd,
          'fmv_max',         pc.fmv_usd,
          'render_count',    1
        )
      END,
      'live_ask', CASE
        WHEN pc.floor_ask IS NULL THEN NULL
        ELSE jsonb_build_object(
          'price',          pc.floor_ask,
          'source',         'pinnacle_catalog',
          'updated_at',     pc.floor_ask_updated_at
        )
      END
    ) INTO result
    FROM pinnacle_catalog pc
    WHERE pc.render_id = p_route_slug;

    IF result IS NOT NULL THEN RETURN result; END IF;

    -- A legacy set-level key (read below, unchanged).
    SELECT jsonb_build_object(
      'id',                pe.id,
      'source',            'pinnacle_editions',
      'collection_id',     v_pinnacle_uuid,
      'collection_slug',   'disney_pinnacle',
      'route_slug',        pe.id,
      'external_id',       pe.external_id,
      'name',              pe.character_name || ' - ' || pe.set_name || ' (' || pe.variant_type || ')',
      'player_name',       pe.character_name,
      'set_name',          pe.set_name,
      'set_slug',          regexp_replace(lower(pe.set_name), '[^a-z0-9]+', '-', 'g'),
      'tier',              pe.variant_type,
      'series_label',      public.series_display_label(p_collection_id, pe.series_year::int),
      'edition_kind',      pe.edition_type,
      'circulation_count', pe.mint_count,
      'is_serialized',     pe.is_serialized,
      'is_chaser',         pe.is_chaser,
      'thumbnail_url',     pe.thumbnail_url,
      'video_url',         NULL::text,
      'team_name',         pe.franchise,
      'first_minted_at',   pe.minting_date,
      'fmv',               CASE
        WHEN fmv.fmv_usd IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fmv_usd',         fmv.fmv_usd,
          'wap_usd',         fmv.wap_usd,
          'floor_usd',       fmv.floor_usd,
          'confidence',      fmv.confidence,
          'computed_at',     fmv.computed_at,
          'sales_count_30d', fmv.sales_count_30d,
          'sales_count_7d',  fmv.sales_count_7d,
          'days_since_sale', fmv.days_since_sale,
          'pinnacle_ask',    fmv.floor_usd,
          'flowty_ask',      NULL::numeric,
          'cross_market_ask',NULL::numeric,
          'listing_count',   NULL::int,
          'offer_count',     NULL::int,
          'fmv_min',         fmv.fmv_min,
          'fmv_max',         fmv.fmv_max,
          'render_count',    fmv.render_count
        )
      END,
      'live_ask', CASE
        WHEN pe.ask_price IS NULL THEN NULL
        ELSE jsonb_build_object(
          'price',          pe.ask_price,
          'source',         pe.ask_source,
          'updated_at',     pe.ask_updated_at
        )
      END
    ) INTO result
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.id = p_route_slug;

    -- 2026-09-26: a legacy key names ONE character for a key that can span
    -- several pins and characters (every Cats & Dogs Vol.1 pin read "Lady").
    -- When the catalog puts more than one character under this key, the row
    -- names the SET, not a character, and lists who is in it.
    IF result IS NOT NULL THEN
      DECLARE
        v_chars text[];
      BEGIN
        SELECT array_agg(DISTINCT btrim(u.ch) ORDER BY btrim(u.ch)) INTO v_chars
        FROM pinnacle_catalog pc
        CROSS JOIN LATERAL unnest(pc.characters) AS u(ch)
        WHERE pc.legacy_edition_key = p_route_slug
          AND btrim(u.ch) NOT IN ('', 'Unknown');
        IF cardinality(v_chars) > 1 THEN
          result := result || jsonb_build_object(
            'name',        (result->>'set_name') || ' (' || (result->>'tier') || ')',
            'player_name', NULL::text,
            'characters',  to_jsonb(v_chars));
        END IF;
      END;
    END IF;

  ELSE
    SELECT jsonb_build_object(
      'id',                e.id::text,
      'source',            'editions',
      'collection_id',     e.collection_id,
      'collection_slug',   c.slug,
      'route_slug',        COALESCE(e.external_id, e.id::text),
      'external_id',       e.external_id,
      'name',              e.name,
      'player_name',       e.player_name,
      'set_name',          e.set_name,
      'set_slug',          CASE
        WHEN e.set_name IS NULL THEN NULL
        ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g')
      END,
      'tier',              e.tier::text,
      'series_label',      public.series_display_label(p_collection_id, e.series::int),
      'series_num',        e.series,
      'edition_kind',      e.edition_kind::text,
      'circulation_count', e.circulation_count,
      'badges',            (
        SELECT coalesce(jsonb_agg(b->>'title'), '[]'::jsonb)
        FROM jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS b
      ),
      'thumbnail_url',     e.thumbnail_url,
      'video_url',         e.video_url,
      'team_name',         e.team_name,
      'first_minted_at',   e.first_minted_at,
      'fmv', CASE
        WHEN fmv.fmv_usd IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fmv_usd',         fmv.fmv_usd,
          'floor_price_usd', fmv.floor_price_usd,
          'wap_usd',         fmv.wap_usd,
          'confidence',      fmv.confidence::text,
          'computed_at',     fmv.computed_at,
          'sales_count_30d', fmv.sales_count_30d,
          'days_since_sale', fmv.days_since_sale,
          'cross_market_ask',fmv.cross_market_ask
        )
      END
    ) INTO result
    FROM editions e
    JOIN collections c ON c.id = e.collection_id
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd, asp_usd AS wap_usd, confidence, computed_at,
             sales_count_30d, days_since_sale, cross_market_ask
      FROM fmv_snapshots
      WHERE edition_id = e.id
      ORDER BY computed_at DESC
      LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND (e.external_id = p_route_slug OR e.id::text = p_route_slug);
  END IF;

  RETURN result;
END;
$function$;

-- anon-exec: unchanged (get_platform_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.get_platform_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total_editions    INT;
  v_total_fmv_covered INT;
  v_total_fmv_pct     NUMERIC;
  v_volume_24h        NUMERIC;
  v_sales_24h         INT;
  v_per_collection    JSONB;
  PINNACLE_UUID CONSTANT UUID := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  TOPSHOT_UUID  CONSTANT UUID := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  -- 2026-09-26: Disney Pinnacle is counted from the render catalog (one row per
  -- PIN, its own FMV + confidence + floor ask), on the same "priced = not
  -- NO_DATA" rule as the other collections. The old read counted set-level
  -- legacy keys (594 for 2,732 pins) with a legacy ask column whose newest
  -- write was ~71 days old.
  SELECT
    (SELECT COUNT(*) FROM editions) + (SELECT COUNT(*) FROM pinnacle_catalog)
  INTO v_total_editions;

  -- Honest coverage: latest snapshot per edition must be priced (<> NO_DATA).
  SELECT
    (SELECT COUNT(*) FROM (
       SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.confidence
       FROM fmv_snapshots fs
       ORDER BY fs.edition_id, fs.computed_at DESC
     ) latest WHERE latest.confidence <> 'NO_DATA') +
    (SELECT COUNT(*) FROM pinnacle_catalog WHERE fmv_usd IS NOT NULL AND fmv_confidence IS DISTINCT FROM 'NO_DATA')
  INTO v_total_fmv_covered;

  v_total_fmv_pct := ROUND(100.0 * v_total_fmv_covered / NULLIF(v_total_editions,0),1);

  SELECT
    COALESCE(SUM(price_usd), 0),
    COALESCE(COUNT(*), 0)::int
  INTO v_volume_24h, v_sales_24h
  FROM (
    SELECT price_usd FROM sales_2026 WHERE sold_at > NOW()-INTERVAL '24h'
    UNION ALL
    SELECT sale_price_usd AS price_usd FROM pinnacle_sales WHERE sold_at > NOW()-INTERVAL '24h'
  ) all_sales;

  SELECT jsonb_agg(col_stats ORDER BY col_stats->>'display_order') INTO v_per_collection
  FROM (
    SELECT jsonb_build_object(
      'slug', c.slug,
      'frontend_slug',
        CASE c.slug
          WHEN 'ufc_strike' THEN 'ufc'
          ELSE replace(c.slug, '_', '-')
        END,
      'name', c.name,
      'edition_count',
        CASE WHEN c.id = PINNACLE_UUID
          THEN (SELECT COUNT(*)::int FROM pinnacle_catalog)
          ELSE (SELECT COUNT(*)::int FROM editions WHERE collection_id = c.id)
        END,
      'fmv_covered',
        CASE WHEN c.id = PINNACLE_UUID
          THEN (SELECT COUNT(*)::int FROM pinnacle_catalog WHERE fmv_usd IS NOT NULL AND fmv_confidence IS DISTINCT FROM 'NO_DATA')
          ELSE (SELECT COUNT(*)::int FROM (
            SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.confidence
            FROM fmv_snapshots fs WHERE fs.collection_id = c.id
            ORDER BY fs.edition_id, fs.computed_at DESC
          ) latest WHERE latest.confidence <> 'NO_DATA')
        END,
      'fmv_pct',
        CASE WHEN c.id = PINNACLE_UUID
          THEN ROUND(100.0 *
            (SELECT COUNT(*) FROM pinnacle_catalog WHERE fmv_usd IS NOT NULL AND fmv_confidence IS DISTINCT FROM 'NO_DATA') /
            NULLIF((SELECT COUNT(*) FROM pinnacle_catalog),0), 1)
          ELSE ROUND(100.0 *
            (SELECT COUNT(*) FROM (
              SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.confidence
              FROM fmv_snapshots fs WHERE fs.collection_id = c.id
              ORDER BY fs.edition_id, fs.computed_at DESC
            ) latest WHERE latest.confidence <> 'NO_DATA') /
            NULLIF((SELECT COUNT(*) FROM editions WHERE collection_id = c.id),0), 1)
        END,
      'volume_24h',
        CASE WHEN c.id = PINNACLE_UUID
          THEN (SELECT COALESCE(SUM(sale_price_usd),0) FROM pinnacle_sales WHERE sold_at > NOW()-INTERVAL '24h')
          ELSE (SELECT COALESCE(SUM(price_usd),0) FROM (
            SELECT price_usd FROM sales_2026 WHERE collection_id = c.id AND sold_at > NOW()-INTERVAL '24h'
            UNION ALL
            SELECT price_usd FROM sales_2025 WHERE collection_id = c.id AND sold_at > NOW()-INTERVAL '24h'
          ) s)
        END,
      'sales_24h',
        CASE WHEN c.id = PINNACLE_UUID
          THEN (SELECT COUNT(*)::int FROM pinnacle_sales WHERE sold_at > NOW()-INTERVAL '24h')
          ELSE (SELECT COUNT(*)::int FROM (
            SELECT id FROM sales_2026 WHERE collection_id = c.id AND sold_at > NOW()-INTERVAL '24h'
            UNION ALL
            SELECT id FROM sales_2025 WHERE collection_id = c.id AND sold_at > NOW()-INTERVAL '24h'
          ) s)
        END,
      'listing_count',
        CASE
          WHEN c.id = TOPSHOT_UUID
          THEN (SELECT COUNT(*)::int FROM badge_editions
                WHERE collection_id = TOPSHOT_UUID AND low_ask IS NOT NULL AND low_ask > 0)
          WHEN c.id = PINNACLE_UUID
          THEN (SELECT COUNT(*)::int FROM pinnacle_catalog WHERE floor_ask IS NOT NULL)
          ELSE (SELECT COUNT(*)::int FROM cached_listings WHERE collection_id = c.id)
        END,
      'fmv_age_minutes',
        CASE WHEN c.id = PINNACLE_UUID
          THEN ROUND(EXTRACT(EPOCH FROM (NOW() -
            (SELECT MAX(fmv_computed_at) FROM pinnacle_catalog)))/60.0, 1)
          ELSE ROUND(EXTRACT(EPOCH FROM (NOW() -
            (SELECT MAX(computed_at) FROM fmv_snapshots WHERE collection_id = c.id)))/60.0, 1)
        END,
      'display_order',
        CASE c.slug
          WHEN 'nba_top_shot'    THEN '1'
          WHEN 'nfl_all_day'     THEN '2'
          WHEN 'disney_pinnacle' THEN '3'
          WHEN 'laliga_golazos'  THEN '4'
          WHEN 'ufc_strike'      THEN '5'
          ELSE '9'
        END
    ) AS col_stats
    FROM collections c
    WHERE c.is_active = true
  ) agg;

  RETURN jsonb_build_object(
    'total_editions',    v_total_editions,
    'total_fmv_covered', v_total_fmv_covered,
    'total_fmv_pct',     v_total_fmv_pct,
    'volume_24h',        v_volume_24h,
    'sales_24h',         v_sales_24h,
    'collection_count',  (SELECT COUNT(*) FROM collections WHERE is_active = true),
    'per_collection',    COALESCE(v_per_collection, '[]'::jsonb),
    'computed_at',       NOW()
  );
END;
$function$;

-- anon-exec: unchanged (analytics_sets_summary) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.analytics_sets_summary(p_collections text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
  base_obj jsonb;
  pinnacle_obj jsonb;
  include_pinnacle boolean := (p_collections IS NULL OR 'pinnacle' = ANY(p_collections));
BEGIN
  WITH normalized AS (
    SELECT
      (CASE c.slug
        WHEN 'nba_top_shot'   THEN 'topshot'
        WHEN 'nfl_all_day'    THEN 'allday'
        WHEN 'laliga_golazos' THEN 'golazos'
        WHEN 'ufc_strike'     THEN 'ufc'
        ELSE c.slug
      END)::text                          AS coll,
      s.id                                AS set_id,
      e.id                                AS edition_id,
      e.tier::text                        AS tier
    FROM sets s
    JOIN collections c ON c.id = s.collection_id
    LEFT JOIN editions e ON e.set_id = s.id
  ),
  -- Build a per-collection per-tier count, then aggregate into a jsonb object
  -- whose keys are the lowercased tier names actually present in the data.
  per_tier AS (
    SELECT
      n.coll,
      lower(COALESCE(n.tier, 'unknown')) AS tier_key,
      COUNT(DISTINCT n.edition_id) FILTER (WHERE n.edition_id IS NOT NULL) AS c
    FROM normalized n
    WHERE (p_collections IS NULL OR n.coll = ANY(p_collections))
    GROUP BY n.coll, lower(COALESCE(n.tier, 'unknown'))
  ),
  tier_obj AS (
    SELECT
      coll,
      jsonb_object_agg(tier_key, c) FILTER (WHERE c > 0) AS tier_breakdown
    FROM per_tier
    GROUP BY coll
  ),
  per_collection AS (
    SELECT
      n.coll,
      jsonb_build_object(
        'set_count',      COUNT(DISTINCT n.set_id),
        'edition_count',  COUNT(DISTINCT n.edition_id),
        'tier_breakdown', COALESCE(t.tier_breakdown, '{}'::jsonb)
      ) AS stats
    FROM normalized n
    LEFT JOIN tier_obj t ON t.coll = n.coll
    WHERE (p_collections IS NULL OR n.coll = ANY(p_collections))
    GROUP BY n.coll, t.tier_breakdown
  )
  SELECT COALESCE(jsonb_object_agg(coll, stats), '{}'::jsonb)
  INTO base_obj
  FROM per_collection;

  IF include_pinnacle THEN
    -- 2026-09-26: counted from the render catalog (one row per PIN). The old
    -- read counted set-level legacy keys and so reported 594 "editions" for
    -- 2,732 pins.
    WITH pinnacle_stats AS (
      SELECT
        COUNT(DISTINCT NULLIF(btrim(set_name), '')) AS set_count,
        COUNT(*) AS edition_count
      FROM pinnacle_catalog
    ),
    pinnacle_breakdown AS (
      SELECT jsonb_object_agg(COALESCE(edition_type, 'unknown'), c) AS tier_breakdown
      FROM (
        SELECT edition_type, COUNT(*) AS c
        FROM pinnacle_catalog
        GROUP BY edition_type
      ) t
    )
    SELECT jsonb_build_object(
      'set_count',     ps.set_count,
      'edition_count', ps.edition_count,
      'tier_breakdown', COALESCE(pb.tier_breakdown, '{}'::jsonb)
    )
    INTO pinnacle_obj
    FROM pinnacle_stats ps, pinnacle_breakdown pb;

    IF pinnacle_obj IS NOT NULL AND (pinnacle_obj->>'edition_count')::int > 0 THEN
      base_obj := base_obj || jsonb_build_object('pinnacle', pinnacle_obj);
    END IF;
  END IF;

  result := jsonb_build_object(
    'collections', base_obj,
    'as_of', now(),
    'note', 'Set-level metrics cover Top Shot, All Day, Golazos, UFC Strike, Disney Pinnacle and Candy MLB. tier_breakdown keys reflect the actual rarity scheme of each collection (Top Shot/All Day/Golazos use common/rare/legendary/ultimate, UFC uses challenger/contender/fandom, Pinnacle uses edition_type variants, Candy MLB uses common/legendary).'
  );

  RETURN result;
END;
$function$;
