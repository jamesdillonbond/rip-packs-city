-- audit_20260810_get_collection_stats_pinnacle_render_grain_and_deal_confidence_d13b_d4b
--
-- D13b (Trevor-authorized 2026-08-10): repoint Pinnacle's overview stats from the
-- legacy 527-edition table to the RENDER-grain pinnacle_catalog (2,457) — the true
-- per-pin grain (legacy edition_key is 91.6% wrong per the render-id-rekey memory).
-- edition_count, FMV coverage, listing_count (now the catalog's FRESH floor_ask,
-- not the 23-day-old legacy ask feed), sniper_deals and tier_breakdown all move to
-- catalog. top_sales STAYS on pinnacle_editions: sales are legacy-keyed events and
-- catalog is 26:1 render-grain, so a catalog join would fan a sale out up to 26x.
-- Verified live: edition_count 527->2457, FMV coverage 69%->95.2%, listings fresh
-- (18h vs 23d), 5 real deals with confidence (was ask-only).
--
-- D4b: sniper_deals now carry `confidence`, and TopShot + Pinnacle are gated to
-- HIGH/MEDIUM FMV confidence (AllDay already was) so the Overview "TOP 5 SNIPER
-- DEALS" can't headline thin-FMV fake "-91% off" bargains. (TS currently returns 0
-- deals with or without the gate — no TS edition meets low_ask<fmv & discount>=15
-- right now — so this is a correct-but-inactive filter there, not a regression.)
-- The Overview page already renders an honest empty state, so no page change.
--
-- Non-Pinnacle non-sniper outputs are byte-identical (those branches are untouched).
-- Revert: CREATE OR REPLACE from the pre-change body (git history) — restores the
-- legacy 527-grain Pinnacle branch and drops the confidence field + the TS gate.

CREATE OR REPLACE FUNCTION public.get_collection_stats(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collection_id UUID;
  v_is_pinnacle BOOLEAN;
  v_is_topshot  BOOLEAN;
  v_is_allday   BOOLEAN;
  v_edition_count INT;
  v_fmv_covered INT;
  v_fmv_pct NUMERIC;
  v_fmv_age_minutes NUMERIC;
  v_fmv_last_at TIMESTAMPTZ;
  v_volume_24h NUMERIC;
  v_sales_24h INT;
  v_volume_7d NUMERIC;
  v_listing_count INT;
  v_listing_cache_at TIMESTAMPTZ;
  v_top_sales JSONB;
  v_sniper_deals JSONB;
  v_tier_breakdown JSONB;
  v_slug_norm TEXT;
BEGIN
  v_slug_norm := replace(p_slug, '-', '_');
  v_slug_norm := CASE v_slug_norm
    WHEN 'ufc'         THEN 'ufc_strike'
    WHEN 'nba'         THEN 'nba_top_shot'
    WHEN 'nfl'         THEN 'nfl_all_day'
    WHEN 'pinnacle'    THEN 'disney_pinnacle'
    WHEN 'golazos'     THEN 'laliga_golazos'
    ELSE v_slug_norm
  END;

  SELECT id INTO v_collection_id FROM collections WHERE slug = v_slug_norm LIMIT 1;
  IF v_collection_id IS NULL THEN
    RETURN jsonb_build_object('error', 'collection_not_found', 'slug', p_slug, 'normalized', v_slug_norm);
  END IF;

  v_is_pinnacle := (v_collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid);
  v_is_topshot  := (v_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid);
  v_is_allday   := (v_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid);

  -- Edition count. D13b: Pinnacle uses the RENDER-grain catalog (2,457), the true
  -- per-pin grain, not the legacy 527-edition table (edition_key 91.6% wrong).
  IF v_is_pinnacle THEN
    SELECT COUNT(*) INTO v_edition_count FROM pinnacle_catalog;
  ELSE
    SELECT COUNT(*) INTO v_edition_count FROM editions WHERE collection_id = v_collection_id;
  END IF;

  -- FMV coverage. D13b: render-grain, self-contained on pinnacle_catalog.
  IF v_is_pinnacle THEN
    SELECT
      COUNT(*) FILTER (WHERE fmv_usd IS NOT NULL),
      ROUND(100.0 * COUNT(*) FILTER (WHERE fmv_usd IS NOT NULL)
            / NULLIF(v_edition_count, 0), 1),
      NULL::numeric,
      MAX(fmv_computed_at)
    INTO v_fmv_covered, v_fmv_pct, v_fmv_age_minutes, v_fmv_last_at
    FROM pinnacle_catalog;
    IF v_fmv_last_at IS NOT NULL THEN
      v_fmv_age_minutes := ROUND(EXTRACT(EPOCH FROM (NOW() - v_fmv_last_at)) / 60.0, 1);
    END IF;
  ELSE
    SELECT
      COUNT(*) FILTER (WHERE latest.confidence <> 'NO_DATA'),
      ROUND(100.0 * COUNT(*) FILTER (WHERE latest.confidence <> 'NO_DATA')
            / NULLIF(v_edition_count, 0), 1)
    INTO v_fmv_covered, v_fmv_pct
    FROM editions e
    CROSS JOIN LATERAL (
      SELECT fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.collection_id = v_collection_id AND fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) latest
    WHERE e.collection_id = v_collection_id;

    SELECT
      ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(fs.computed_at))) / 60.0, 1),
      MAX(fs.computed_at)
    INTO v_fmv_age_minutes, v_fmv_last_at
    FROM fmv_snapshots fs WHERE fs.collection_id = v_collection_id;
  END IF;

  -- Sales volume (unchanged — pinnacle_sales are legacy-grain sale events).
  IF v_is_pinnacle THEN
    SELECT
      COALESCE(SUM(CASE WHEN sold_at > NOW() - INTERVAL '24h' THEN sale_price_usd END), 0),
      COALESCE(COUNT(CASE WHEN sold_at > NOW() - INTERVAL '24h' THEN 1 END), 0)::int,
      COALESCE(SUM(CASE WHEN sold_at > NOW() - INTERVAL '7 days' THEN sale_price_usd END), 0)
    INTO v_volume_24h, v_sales_24h, v_volume_7d
    FROM pinnacle_sales;
  ELSE
    SELECT
      COALESCE(SUM(CASE WHEN sold_at > NOW() - INTERVAL '24h' THEN price_usd END), 0),
      COALESCE(COUNT(CASE WHEN sold_at > NOW() - INTERVAL '24h' THEN 1 END), 0)::int,
      COALESCE(SUM(CASE WHEN sold_at > NOW() - INTERVAL '7 days' THEN price_usd END), 0)
    INTO v_volume_24h, v_sales_24h, v_volume_7d
    FROM (
      SELECT price_usd, sold_at FROM sales_2026 WHERE collection_id = v_collection_id
      UNION ALL
      SELECT price_usd, sold_at FROM sales_2025 WHERE collection_id = v_collection_id
        AND sold_at > NOW() - INTERVAL '7 days'
    ) s;
  END IF;

  -- Listing count and cache timestamp. D13b: Pinnacle uses the catalog's FRESH
  -- render-grain floor_ask (was the 23-day-old legacy pinnacle_editions.ask feed).
  IF v_is_pinnacle THEN
    SELECT COUNT(*) FILTER (WHERE floor_ask IS NOT NULL), MAX(floor_ask_updated_at)
    INTO v_listing_count, v_listing_cache_at
    FROM pinnacle_catalog;
  ELSIF v_is_topshot THEN
    SELECT
      COUNT(*) FILTER (WHERE be.low_ask > 0 AND be.low_ask IS NOT NULL),
      (SELECT MAX(ingested_at) FROM ts_listings)
    INTO v_listing_count, v_listing_cache_at
    FROM badge_editions be
    WHERE be.collection_id = v_collection_id;
  ELSIF v_is_allday THEN
    SELECT COUNT(*), MAX(floor_ask_listed_at)
    INTO v_listing_count, v_listing_cache_at
    FROM allday_edition_floor_ask;
  ELSE
    SELECT COUNT(*), MAX(cached_at) INTO v_listing_count, v_listing_cache_at
    FROM cached_listings WHERE collection_id = v_collection_id;
  END IF;

  -- Top 5 recent sales (unchanged — sales are legacy-keyed; join pinnacle_editions
  -- for the name at legacy grain to avoid the 26:1 catalog fan-out).
  IF v_is_pinnacle THEN
    SELECT jsonb_agg(t ORDER BY t.price DESC)::jsonb INTO v_top_sales
    FROM (
      SELECT ps.sale_price_usd AS price, ps.serial_number, ps.sold_at,
             pe.character_name AS edition_name, pe.variant_type AS tier, pe.character_name
      FROM pinnacle_sales ps
      LEFT JOIN pinnacle_editions pe ON pe.edition_key = ps.edition_id
      WHERE ps.sold_at > NOW() - INTERVAL '24h'
      ORDER BY ps.sale_price_usd DESC LIMIT 5
    ) t;
  ELSE
    SELECT jsonb_agg(t ORDER BY t.price DESC)::jsonb INTO v_top_sales
    FROM (
      SELECT s.price_usd AS price, s.serial_number, s.sold_at,
             e.player_name, e.set_name, e.tier::text AS tier, e.circulation_count
      FROM sales_2026 s
      LEFT JOIN editions e ON e.id = s.edition_id
      WHERE s.collection_id = v_collection_id AND s.sold_at > NOW() - INTERVAL '24h'
      ORDER BY s.price_usd DESC LIMIT 5
    ) t;
  END IF;

  -- Sniper deals. D4b: every branch now carries `confidence`, and TopShot +
  -- Pinnacle are gated to HIGH/MEDIUM FMV confidence (AllDay already was) so the
  -- Overview headline can't show thin-FMV fake "-91% off" bargains. D13b: Pinnacle
  -- reads the render-grain catalog with real fmv/discount (was ask-only, 23d stale).
  IF v_is_pinnacle THEN
    SELECT jsonb_agg(t ORDER BY t.discount DESC)::jsonb INTO v_sniper_deals
    FROM (
      SELECT pc.render_id AS flow_id, pc.character_name AS player_name,
             pc.set_name, pc.variant AS tier, NULL::int AS serial_number,
             pc.total_minted AS circulation_count, pc.floor_ask AS ask_price,
             pc.fmv_usd AS fmv,
             ROUND((pc.fmv_usd - pc.floor_ask) / NULLIF(pc.fmv_usd, 0) * 100) AS discount,
             NULL::text AS buy_url, pc.thumbnail_url, ARRAY[]::text[] AS badge_slugs,
             pc.fmv_confidence::text AS confidence
      FROM pinnacle_catalog pc
      WHERE pc.floor_ask IS NOT NULL AND pc.floor_ask > 0
        AND pc.fmv_usd IS NOT NULL AND pc.fmv_usd > 0
        AND pc.floor_ask < pc.fmv_usd
        AND pc.fmv_confidence IN ('HIGH','MEDIUM')
        AND ROUND((pc.fmv_usd - pc.floor_ask) / NULLIF(pc.fmv_usd, 0) * 100) >= 15
      ORDER BY discount DESC LIMIT 5
    ) t;
  ELSIF v_is_topshot THEN
    SELECT jsonb_agg(t ORDER BY t.discount DESC)::jsonb INTO v_sniper_deals
    FROM (
      SELECT
        be.external_id                                                    AS flow_id,
        be.player_name,
        be.set_name,
        replace(COALESCE(be.tier, 'UNKNOWN'), 'MOMENT_TIER_', '')        AS tier,
        NULL::int                                                         AS serial_number,
        be.circulation_count,
        be.low_ask                                                        AS ask_price,
        latest_fmv.fmv_usd                                               AS fmv,
        ROUND((latest_fmv.fmv_usd - be.low_ask)
              / NULLIF(latest_fmv.fmv_usd, 0) * 100)                     AS discount,
        NULL::text                                                        AS buy_url,
        NULL::text                                                        AS thumbnail_url,
        ARRAY[]::text[]                                                   AS badge_slugs,
        latest_fmv.confidence::text                                       AS confidence
      FROM badge_editions be
      JOIN editions e ON e.external_id = be.external_id
        AND e.collection_id = v_collection_id
      JOIN LATERAL (
        SELECT fmv_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id AND fmv_usd > 0
        ORDER BY computed_at DESC
        LIMIT 1
      ) latest_fmv ON true
      WHERE be.collection_id = v_collection_id
        AND be.flow_retired = false
        AND be.parallel_id = 0
        AND be.low_ask IS NOT NULL AND be.low_ask > 0
        AND be.low_ask < latest_fmv.fmv_usd
        AND latest_fmv.confidence IN ('HIGH','MEDIUM')
        AND (latest_fmv.fmv_usd - be.low_ask)
            / NULLIF(latest_fmv.fmv_usd, 0) * 100 >= 15
      ORDER BY discount DESC
      LIMIT 5
    ) t;
  ELSIF v_is_allday THEN
    SELECT jsonb_agg(t ORDER BY t.discount DESC)::jsonb INTO v_sniper_deals
    FROM (
      SELECT
        e.external_id                                                    AS flow_id,
        e.player_name,
        e.set_name,
        e.tier::text                                                     AS tier,
        NULL::int                                                        AS serial_number,
        e.circulation_count,
        afa.floor_ask                                                    AS ask_price,
        f.fmv_usd                                                        AS fmv,
        ROUND((f.fmv_usd - afa.floor_ask) / NULLIF(f.fmv_usd, 0) * 100)  AS discount,
        'https://nflallday.com/listing/' || afa.floor_listing_resource_id::text AS buy_url,
        e.thumbnail_url,
        ARRAY[]::text[]                                                  AS badge_slugs,
        f.confidence::text                                               AS confidence
      FROM allday_edition_floor_ask afa
      JOIN editions e ON e.id = afa.edition_id AND e.collection_id = v_collection_id
      JOIN LATERAL (
        SELECT fmv_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id AND fmv_usd > 0
        ORDER BY computed_at DESC
        LIMIT 1
      ) f ON true
      WHERE f.confidence::text IN ('HIGH','MEDIUM')
        AND afa.floor_ask >= 1
        AND afa.floor_ask < f.fmv_usd
        AND ROUND((f.fmv_usd - afa.floor_ask) / NULLIF(f.fmv_usd, 0) * 100) >= 15
      ORDER BY discount DESC
      LIMIT 5
    ) t;
  ELSE
    SELECT jsonb_agg(t ORDER BY t.discount DESC)::jsonb INTO v_sniper_deals
    FROM (
      SELECT cl.flow_id, cl.player_name, cl.set_name, cl.tier, cl.serial_number,
             cl.circulation_count, cl.ask_price, cl.fmv, cl.discount,
             cl.buy_url, cl.thumbnail_url, cl.badge_slugs,
             NULL::text AS confidence
      FROM cached_listings cl
      WHERE cl.collection_id = v_collection_id AND cl.discount >= 15
        AND cl.fmv IS NOT NULL AND cl.ask_price > 0
      ORDER BY cl.discount DESC LIMIT 5
    ) t;
  END IF;

  -- Tier breakdown. D13b: Pinnacle render-grain, consistent with edition_count.
  IF v_is_pinnacle THEN
    SELECT jsonb_object_agg(tier_text, cnt) INTO v_tier_breakdown
    FROM (
      SELECT COALESCE(edition_type, 'UNKNOWN') AS tier_text, COUNT(*) AS cnt
      FROM pinnacle_catalog GROUP BY edition_type
    ) tb;
  ELSE
    SELECT jsonb_object_agg(tier_text, cnt) INTO v_tier_breakdown
    FROM (
      SELECT COALESCE(replace(tier::text, 'MOMENT_TIER_', ''), 'UNKNOWN') AS tier_text,
             COUNT(*) AS cnt
      FROM editions WHERE collection_id = v_collection_id GROUP BY tier
    ) tb;
  END IF;

  RETURN jsonb_build_object(
    'collection_id', v_collection_id,
    'slug', v_slug_norm,
    'edition_count', v_edition_count,
    'fmv_covered', v_fmv_covered,
    'fmv_pct', v_fmv_pct,
    'fmv_age_minutes', v_fmv_age_minutes,
    'fmv_last_at', v_fmv_last_at,
    'volume_24h', v_volume_24h,
    'sales_24h', v_sales_24h,
    'volume_7d', v_volume_7d,
    'listing_count', v_listing_count,
    'listing_cache_at', v_listing_cache_at,
    'top_sales', COALESCE(v_top_sales, '[]'::jsonb),
    'sniper_deals', COALESCE(v_sniper_deals, '[]'::jsonb),
    'tier_breakdown', COALESCE(v_tier_breakdown, '{}'::jsonb)
  );
END;
$function$;
