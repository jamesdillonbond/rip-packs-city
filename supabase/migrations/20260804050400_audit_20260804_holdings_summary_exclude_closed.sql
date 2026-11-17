-- audit_20260804_holdings_summary_exclude_closed
--
-- Wallet path for closed markets (grand-total RPC 3 of 3 — feeds
-- seeded_wallets.cached_fmv_usd via refresh_seeded_wallet_stats, i.e. the
-- profile / wallets-hub / OG totals). Grand total_fmv_usd excludes closed
-- markets; per-collection entries keep their count + sum and gain
-- market_closed_at. After applying, refresh_seeded_wallet_stats was re-run for
-- every seeded wallet holding UFC so the cached totals dropped UFC immediately.
--
-- Applied live via MCP apply_migration 2026-08-03 (PT). Revert: git revert the
-- code commit + restore the prior body.
CREATE OR REPLACE FUNCTION public.holdings_summary(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_username text;
  v_collections jsonb;
  v_total_moments int := 0;
  v_total_fmv_usd numeric := 0;
  v_collections_held int := 0;
  v_top_collection text;
  v_concentration_pct numeric;
  v_concentration_label text;
  v_diversity_score numeric;
  v_sum_squared_shares numeric := 0;
BEGIN
  SELECT COALESCE(sw.username, wu.username) INTO v_username
  FROM (SELECT 1) dummy
  LEFT JOIN seeded_wallets sw ON LOWER(sw.wallet_address) = v_wallet
  LEFT JOIN wallet_usernames wu ON wu.wallet_addr = v_wallet
  LIMIT 1;

  WITH
  resolved AS (
    SELECT
      c.slug,
      c.id AS collection_id,
      c.market_closed_at,
      COALESCE(e.tier::text, wmc.tier) AS resolved_tier,
      CASE
        -- June 6 (Wave 2): Pinnacle reads wmc.fmv_usd -- the per-render FMV
        -- denormalized hourly from pinnacle_catalog (Wave 1a).
        WHEN c.slug = 'disney_pinnacle' THEN wmc.fmv_usd
        ELSE uf.fmv_usd
      END AS resolved_fmv_usd,
      wmc.edition_key
    FROM wallet_moments_cache wmc
    JOIN collections c ON c.id = wmc.collection_id
    LEFT JOIN editions e ON e.external_id = wmc.edition_key
      AND e.collection_id = wmc.collection_id
      AND c.slug != 'disney_pinnacle'
    -- Correlated latest-non-null FMV for ONLY the editions this wallet holds.
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd
      FROM fmv_snapshots_2026 fs
      WHERE fs.edition_id = e.id
        AND fs.fmv_usd IS NOT NULL
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) uf ON true
    WHERE wmc.wallet_address = v_wallet
  ),
  per_coll_basics AS (
    SELECT
      slug,
      collection_id,
      MIN(market_closed_at) AS market_closed_at,
      COUNT(*) AS moment_count,
      COUNT(*) FILTER (WHERE edition_key IS NOT NULL) AS with_edition_key,
      COUNT(*) FILTER (WHERE resolved_fmv_usd IS NOT NULL) AS with_fmv,
      COUNT(*) FILTER (WHERE resolved_tier IS NOT NULL) AS with_tier,
      COALESCE(SUM(resolved_fmv_usd), 0) AS sum_fmv_usd
    FROM resolved GROUP BY slug, collection_id
  ),
  per_coll_tiers AS (
    SELECT
      slug,
      collection_id,
      jsonb_object_agg(resolved_tier, cnt) AS tier_breakdown
    FROM (
      SELECT slug, collection_id, resolved_tier, COUNT(*) AS cnt
      FROM resolved
      WHERE resolved_tier IS NOT NULL
      GROUP BY slug, collection_id, resolved_tier
    ) sub
    GROUP BY slug, collection_id
  ),
  joined AS (
    SELECT pcb.*, pct.tier_breakdown
    FROM per_coll_basics pcb
    LEFT JOIN per_coll_tiers pct USING (slug, collection_id)
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      'slug', slug,
      'moment_count', moment_count,
      'metadata_coverage_pct', ROUND(100.0 * with_edition_key / NULLIF(moment_count, 0), 1),
      'fmv_coverage_pct', ROUND(100.0 * with_fmv / NULLIF(moment_count, 0), 1),
      'tier_coverage_pct', ROUND(100.0 * with_tier / NULLIF(moment_count, 0), 1),
      'sum_fmv_usd', ROUND(sum_fmv_usd, 2),
      'market_closed_at', market_closed_at,
      'tier_breakdown', COALESCE(tier_breakdown, '{}'::jsonb),
      'render_status', CASE
        WHEN moment_count = 0 THEN 'empty'
        WHEN with_edition_key::numeric / NULLIF(moment_count, 0) >= 0.95 THEN 'full'
        WHEN with_edition_key::numeric / NULLIF(moment_count, 0) >= 0.5 THEN 'partial'
        ELSE 'metadata_pending'
      END
    ) ORDER BY moment_count DESC),
    SUM(moment_count),
    -- Grand FMV excludes closed markets (dead-market value is not a portfolio
    -- total). Per-collection sum_fmv_usd is retained above for reference/UI, but
    -- the wallet-level cached total this feeds (seeded_wallets.cached_fmv_usd)
    -- must not include a closed collection.
    SUM(sum_fmv_usd) FILTER (WHERE market_closed_at IS NULL),
    COUNT(*)
  INTO v_collections, v_total_moments, v_total_fmv_usd, v_collections_held
  FROM joined
  WHERE moment_count > 0;

  IF v_total_moments > 0 THEN
    SELECT slug, ROUND(100.0 * moment_count / v_total_moments, 1)
    INTO v_top_collection, v_concentration_pct
    FROM (
      SELECT slug, moment_count
      FROM jsonb_to_recordset(v_collections) AS r(slug text, moment_count int)
      ORDER BY moment_count DESC LIMIT 1
    ) top;

    SELECT SUM(POWER(moment_count::numeric / v_total_moments, 2))
    INTO v_sum_squared_shares
    FROM jsonb_to_recordset(v_collections) AS r(moment_count int);

    v_diversity_score := ROUND(1 - v_sum_squared_shares, 3);

    v_concentration_label := CASE
      WHEN v_concentration_pct >= 95 THEN 'mono-collection'
      WHEN v_concentration_pct >= 75 THEN 'primary + light dabbler'
      WHEN v_concentration_pct >= 50 THEN 'primary + secondary'
      ELSE 'genuinely diversified'
    END;
  END IF;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'username', v_username,
    'total_moments', COALESCE(v_total_moments, 0),
    'total_fmv_usd', ROUND(COALESCE(v_total_fmv_usd, 0), 2),
    'collections_held', COALESCE(v_collections_held, 0),
    'top_collection', v_top_collection,
    'top_collection_pct', v_concentration_pct,
    'concentration_label', v_concentration_label,
    'diversity_score', v_diversity_score,
    'collections', COALESCE(v_collections, '[]'::jsonb)
  );
END;
$function$;
