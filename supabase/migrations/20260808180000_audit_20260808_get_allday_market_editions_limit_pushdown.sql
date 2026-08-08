-- Perf: /api/market (public AllDay Market tab) was 504ing ~19% of requests
-- (chronic) because get_allday_market_editions computed the per-edition fmv
-- LATERAL for ALL ~4,300 listed AllDay editions on every load (7s warm / 12s
-- cold) before sorting + LIMIT. For the fmv-INDEPENDENT sorts (price_asc/
-- price_desc) with no min-discount filter, the sort key (floor_ask) comes only
-- from the listings aggregate, so we can sort + LIMIT first and run the fmv
-- LATERAL for just the returned page (~60 lookups, not ~4,300). Output is
-- byte-identical (validated: 0-row EXCEPT diff both ways vs the prior body for
-- the default params; 72ms warm / ~2s cold vs 7-12s before). fmv-dependent
-- sorts (discount_desc/fmv_desc) and any min-discount filter keep the original
-- single-phase path unchanged. Applied to prod via MCP as
-- audit_20260808_get_allday_market_editions_limit_pushdown; committed here so
-- the repo reflects the live definition (CREATE OR REPLACE preserves grants:
-- service_role EXECUTE yes, anon no).
CREATE OR REPLACE FUNCTION public.get_allday_market_editions(
  p_min_discount numeric DEFAULT 0,
  p_max_price numeric DEFAULT 0,
  p_rarity text DEFAULT 'all'::text,
  p_team text DEFAULT 'all'::text,
  p_sort_by text DEFAULT 'listed_desc'::text,
  p_limit integer DEFAULT 500)
RETURNS TABLE(edition_id uuid, external_id text, player_name text, team_name text,
  set_name text, series_name text, tier text, circulation_count integer,
  floor_ask numeric, listed_count integer, fmv_usd numeric, discount_pct numeric,
  confidence text, thumbnail_url text, badges text[], last_listed_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_sort_by IN ('price_asc','price_desc') AND COALESCE(p_min_discount,0) = 0 THEN
    -- Fast path: LIMIT before the fmv LATERAL (sort key is agg-only).
    RETURN QUERY
    WITH agg AS (
      SELECT cl.edition_id,
             min(cl.price_usd)   AS floor_ask,
             count(*)::int        AS listed_count,
             max(cl.listed_at)    AS last_listed_at
      FROM cached_listings_v2 cl
      WHERE cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
        AND cl.completed_at IS NULL
        AND cl.source <> 'flowty'
        AND cl.price_usd IS NOT NULL
        AND cl.price_usd > 0
      GROUP BY cl.edition_id
    ),
    top AS (
      SELECT e.id AS eid, e.external_id, e.player_name, e.team_name, e.set_name,
             e.series, e.tier, e.circulation_count, e.thumbnail_url, e.badges,
             g.floor_ask AS f_ask, g.listed_count AS l_count, g.last_listed_at AS ll_at
      FROM agg g
      JOIN editions e ON e.id = g.edition_id
      WHERE (p_rarity = 'all' OR UPPER(e.tier::text) = UPPER(p_rarity))
        AND (p_team = 'all' OR e.team_name ILIKE p_team)
        AND (COALESCE(p_max_price, 0) = 0 OR g.floor_ask <= p_max_price)
      ORDER BY
        CASE WHEN p_sort_by = 'price_asc'  THEN g.floor_ask END ASC  NULLS LAST,
        CASE WHEN p_sort_by = 'price_desc' THEN g.floor_ask END DESC NULLS LAST,
        g.last_listed_at DESC NULLS LAST
      LIMIT COALESCE(p_limit, 500)
    )
    SELECT
      t.eid, t.external_id::text, t.player_name::text, t.team_name::text,
      t.set_name::text, t.series::text, t.tier::text, t.circulation_count,
      t.f_ask, t.l_count, fs.fmv_usd,
      CASE WHEN fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0
           THEN ROUND(((fs.fmv_usd - t.f_ask) / fs.fmv_usd) * 100, 1)
           ELSE NULL END,
      COALESCE(fs.confidence::text, 'ASK_ONLY'),
      t.thumbnail_url::text, t.badges, t.ll_at
    FROM top t
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.confidence
      FROM fmv_snapshots s
      WHERE s.edition_id = t.eid AND s.fmv_usd IS NOT NULL
        AND s.computed_at > now() - interval '90 days'
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fs ON true
    ORDER BY
      CASE WHEN p_sort_by = 'price_asc'  THEN t.f_ask END ASC  NULLS LAST,
      CASE WHEN p_sort_by = 'price_desc' THEN t.f_ask END DESC NULLS LAST,
      t.ll_at DESC NULLS LAST;
  ELSE
    -- fmv-dependent path (discount_desc / fmv_desc sort, or a min-discount
    -- filter): unchanged single-phase — fmv must be known for every edition
    -- before the sort/limit.
    RETURN QUERY
    WITH agg AS (
      SELECT cl.edition_id,
             min(cl.price_usd)   AS floor_ask,
             count(*)::int        AS listed_count,
             max(cl.listed_at)    AS last_listed_at
      FROM cached_listings_v2 cl
      WHERE cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
        AND cl.completed_at IS NULL
        AND cl.source <> 'flowty'
        AND cl.price_usd IS NOT NULL
        AND cl.price_usd > 0
      GROUP BY cl.edition_id
    )
    SELECT
      e.id, e.external_id::text, e.player_name::text, e.team_name::text,
      e.set_name::text, e.series::text, e.tier::text, e.circulation_count,
      g.floor_ask, g.listed_count, fs.fmv_usd,
      CASE WHEN fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0
           THEN ROUND(((fs.fmv_usd - g.floor_ask) / fs.fmv_usd) * 100, 1)
           ELSE NULL END AS discount_pct,
      COALESCE(fs.confidence::text, 'ASK_ONLY') AS confidence,
      e.thumbnail_url::text, e.badges, g.last_listed_at
    FROM agg g
    JOIN editions e ON e.id = g.edition_id
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.confidence
      FROM fmv_snapshots s
      WHERE s.edition_id = e.id AND s.fmv_usd IS NOT NULL
        AND s.computed_at > now() - interval '90 days'
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fs ON true
    WHERE (p_rarity = 'all' OR UPPER(e.tier::text) = UPPER(p_rarity))
      AND (p_team = 'all' OR e.team_name ILIKE p_team)
      AND (COALESCE(p_max_price, 0) = 0 OR g.floor_ask <= p_max_price)
      AND (COALESCE(p_min_discount, 0) = 0
           OR (fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0
               AND ROUND(((fs.fmv_usd - g.floor_ask) / fs.fmv_usd) * 100, 1) >= p_min_discount))
    ORDER BY
      CASE WHEN p_sort_by = 'price_asc'  THEN g.floor_ask END ASC  NULLS LAST,
      CASE WHEN p_sort_by = 'price_desc' THEN g.floor_ask END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'fmv_desc'   THEN fs.fmv_usd  END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'discount_desc' THEN
        (CASE WHEN fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0
              THEN ((fs.fmv_usd - g.floor_ask) / fs.fmv_usd) END)
      END DESC NULLS LAST,
      g.last_listed_at DESC NULLS LAST
    LIMIT COALESCE(p_limit, 500);
  END IF;
END;
$function$;
