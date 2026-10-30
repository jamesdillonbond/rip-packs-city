-- audit_20261030_listing_counts_read_the_onchain_book_not_flowty
-- anon-exec: unchanged (get_platform_stats, get_collection_stats) — CREATE OR REPLACE keeps each ACL (has_function_privilege anon=false, verified 2026-10-30).
--
-- 2026-10-30, Flowty retirement runbook §3: the Flowty API has been dark since 10-27 ~9:20 PM PT and the
-- Flowty v1 `cached_listings` rows (Top Shot 111 / All Day 108 / Golazos 100) were deleted with a backup
-- (audit_20261030_flowty_cached_listings_backup). The generic listing_count arms read v1, so All Day and
-- Golazos would have published a fabricated 0. They now count editions with an open on-chain ask in
-- cached_listings_v2, the EDITION grain the Top Shot and Pinnacle arms already use.
--   get_platform_stats    prosrc md5 228cc552c1a18355a0a584cbef39140d -> a707d0df57abcf3c1a15806392635d14
--                          (All Day 108 -> 4,500, Golazos 100 -> 496, read 10-30 10:23 AM PT)
--   get_collection_stats  prosrc md5 f024d7dfae7544b01db2b69a17b25dd4 -> 56071095793b343bc8ceea8708c63973
--                          (Golazos listing_count 100 -> 496; All Day already reads allday_edition_floor_ask)
-- Applied live as md5-guarded anchor replaces over pg_get_functiondef. get_platform_stats is written out in
-- full (it is DB-invariant pinned); get_collection_stats keeps its splice pattern (20261004170500).
-- get_collection_stats' Golazos sniper-deals arm still reads v1 and is now honestly empty (no Flowty rows).
--
-- REVERT: re-run the splices with old/new swapped, guarded on the new md5s above.

-- get_collection_stats first: the repo DB guards read a CREATE body to the next CREATE or EOF, so a
-- splice placed after the CREATE below would be read as part of get_platform_stats.
DO $live$
DECLARE d text; a text; b text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_collection_stats(text)'::regprocedure) <> 'f024d7dfae7544b01db2b69a17b25dd4' THEN RAISE EXCEPTION 'get_collection_stats: live body is not the one read'; END IF;
  d := pg_get_functiondef('public.get_collection_stats(text)'::regprocedure);
  a := $p$    SELECT COUNT(*), MAX(cached_at) INTO v_listing_count, v_listing_cache_at
    FROM cached_listings WHERE collection_id = v_collection_id;
$p$;
  b := $q$    SELECT COUNT(DISTINCT cl.edition_id), MAX(cl.listed_at) INTO v_listing_count, v_listing_cache_at
    FROM cached_listings_v2 cl
    WHERE cl.collection_id = v_collection_id AND cl.completed_at IS NULL AND cl.edition_id IS NOT NULL
      AND cl.price_usd > 0 AND (cl.expiry_at IS NULL OR cl.expiry_at > now());
$q$;
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN RAISE EXCEPTION 'get_collection_stats: anchor count'; END IF;
  EXECUTE replace(d, a, b);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_collection_stats(text)'::regprocedure) <> '56071095793b343bc8ceea8708c63973' THEN RAISE EXCEPTION 'get_collection_stats: result md5'; END IF;
END $live$;

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
          ELSE (SELECT COUNT(DISTINCT cl.edition_id)::int FROM cached_listings_v2 cl
                 WHERE cl.collection_id = c.id AND cl.completed_at IS NULL AND cl.edition_id IS NOT NULL
                   AND cl.price_usd > 0 AND (cl.expiry_at IS NULL OR cl.expiry_at > now()))
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
      AND c.slug <> 'panini_blockchain'  -- #64: Panini sales/listings are not in sales/cached_listings
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
