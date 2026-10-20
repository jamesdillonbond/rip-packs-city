-- audit_20261020_snapshot_panini_spliced_platform_stats_and_fmv_tier_pulse
-- anon-exec: unchanged (get_platform_stats) — snapshot of the live definition; CREATE OR REPLACE keeps the ACL (has_function_privilege anon=false, verified 2026-10-20).
-- anon-exec: unchanged (analytics_fmv_tier_pulse) — snapshot of the live definition; CREATE OR REPLACE keeps the ACL (has_function_privilege anon=false, verified 2026-10-20).
--
-- 2026-10-20 RE-PIN SNAPSHOT — NOT APPLIED, AND NOTHING TO APPLY. Byte-identical capture of what
-- production already runs (docs/reference/database.md, "Re-pinning a stale DB-invariant pin").
--
-- WHY. 20261019181549_audit_20261019_panini_flip_readiness_blockers rewrote both functions IN PLACE
-- (a DO block: md5-guarded replace() over pg_get_functiondef, then EXECUTE) to keep Panini out of
-- per_collection / the /analytics/fmv board. That left no committed full body for either, so their
-- DB-invariant pins kept naming the pre-Panini migrations and the daily db-pin-staleness run went
-- red (2026-10-20 5:47 AM PT: "checked 322 pins — 320 clean, 2 needing attention"). The repo-side
-- guard (__tests__/db-pin-points-at-the-newest-defining-migration.test.ts) only recognised
-- CREATE OR REPLACE, so it could not see the splice; it now does, in the same push as this file.
--
-- HOW EACH BODY WAS BUILT. The pinned body, with that migration's own anchor replaced exactly once:
--   get_platform_stats        prosrc md5 b1887a0cb7159db6c49f54293f441e3d -> 228cc552c1a18355a0a584cbef39140d
--   analytics_fmv_tier_pulse  prosrc md5 58bb20b4472c9d4d87d7f5ffe63071ad -> 114e5d2a7de1150bb03a635538e61641
-- Both results equal md5(prosrc) on production (read 2026-10-20 via MCP). Headers are pg_get_functiondef's.
--
-- REVERT: delete this file and point the two PINS entries back at their previous migrations.

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

CREATE OR REPLACE FUNCTION public.analytics_fmv_tier_pulse(p_collections text[] DEFAULT NULL::text[])
 RETURNS TABLE(collection text, tier text, edition_count bigint, total_fmv_usd numeric, avg_fmv_usd numeric, median_fmv_usd numeric, high_conf_count bigint, low_conf_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH latest_fmv AS (
    SELECT DISTINCT ON (s.edition_id)
      s.edition_id,
      s.fmv_usd,
      s.confidence::text AS confidence,
      (CASE c.slug
        WHEN 'nba_top_shot'    THEN 'topshot'
        WHEN 'nfl_all_day'     THEN 'allday'
        WHEN 'laliga_golazos'  THEN 'golazos'
        WHEN 'ufc_strike'      THEN 'ufc'
        ELSE c.slug::text
      END)::text AS coll
    FROM fmv_snapshots_2026 s
    JOIN collections c ON c.id = s.collection_id
    WHERE s.computed_at >= now() - interval '24 hours'
      AND s.confidence != 'ASK_ONLY'
      AND c.is_active = true
      AND c.slug <> 'disney_pinnacle'
      AND c.slug <> 'panini_blockchain'  -- #64: the /analytics/fmv board has no Panini key
    ORDER BY s.edition_id, s.computed_at DESC
  ),
  -- 2026-09-28: Pinnacle's FMV lives on pinnacle_catalog (one row per pin) and
  -- is never written to fmv_snapshots_2026 (measured: 0 rows), so the FMV Health
  -- card read "No FMV coverage yet." for a collection with 1,580 priced pins.
  -- Same filters as the arm above: computed in the last 24 h, not ASK_ONLY, has
  -- a price. Pinnacle has no rarity tier; the pin's variant stands in for it.
  pinnacle_fmv AS (
    SELECT
      pc.fmv_usd,
      pc.fmv_confidence::text AS confidence,
      'pinnacle'::text AS coll,
      pc.variant AS pin_tier
    FROM pinnacle_catalog pc
    WHERE pc.fmv_computed_at >= now() - interval '24 hours'
      AND pc.fmv_usd IS NOT NULL
      AND pc.fmv_confidence::text <> 'ASK_ONLY'
  ),
  unioned AS (
    SELECT f.coll, COALESCE(e.tier::text, 'UNKNOWN') AS t, f.fmv_usd, f.confidence
    FROM latest_fmv f
    LEFT JOIN editions e ON e.id = f.edition_id
    UNION ALL
    SELECT p.coll, COALESCE(p.pin_tier, 'UNKNOWN') AS t, p.fmv_usd, p.confidence
    FROM pinnacle_fmv p
  )
  SELECT
    u.coll AS collection,
    u.t AS tier,
    COUNT(*)::bigint                                                                AS edition_count,
    COALESCE(ROUND(SUM(u.fmv_usd)::numeric, 0), 0)                                  AS total_fmv_usd,
    COALESCE(ROUND(AVG(u.fmv_usd)::numeric, 2), 0)                                  AS avg_fmv_usd,
    COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY u.fmv_usd)::numeric, 2), 0) AS median_fmv_usd,
    COUNT(*) FILTER (WHERE u.confidence = 'HIGH')::bigint                           AS high_conf_count,
    COUNT(*) FILTER (WHERE u.confidence = 'LOW')::bigint                            AS low_conf_count
  FROM unioned u
  WHERE (p_collections IS NULL OR u.coll = ANY(p_collections))
  GROUP BY u.coll, u.t
  ORDER BY total_fmv_usd DESC;
END;
$function$;
