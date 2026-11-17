-- Per-set detail for NFL All Day set deep-dives. The aggregate
-- get_allday_set_progress returns only a top-5 missing PREVIEW and no owned
-- list, so the sets-page detail modal / card-expand rendered nothing for
-- AllDay (owned[] was hardcoded empty in the route). This returns the FULL
-- owned + missing edition lists for a single set so those surfaces work for
-- AllDay the same way /api/sets?set= makes them work for Top Shot.
--
-- Owned is one row per distinct owned edition (representative = MIN serial),
-- matching the ownedPlays count semantics of the aggregate. Missing carries
-- latest fmv_usd as the value hint (no live ask in this path, same as the
-- aggregate's preview). SECDEF + mirrored grants (authenticated/service_role/
-- postgres; anon NOT granted) — called via the service-role route.
CREATE OR REPLACE FUNCTION public.get_allday_set_detail(
  p_wallet text,
  p_set_id uuid,
  p_collection_id uuid DEFAULT 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH universe AS (
  SELECT e.id AS edition_id, e.external_id, e.player_name,
         e.tier::text AS tier, e.thumbnail_url
  FROM editions e
  WHERE e.collection_id = p_collection_id
    AND e.set_id = p_set_id
),
owned AS (
  SELECT u.edition_id, MIN(wmc.serial_number) AS serial_number
  FROM universe u
  JOIN wallet_moments_cache wmc
    ON wmc.collection_id = p_collection_id
   AND wmc.edition_key = u.external_id
   AND lower(wmc.wallet_address) = lower(p_wallet)
  GROUP BY u.edition_id
),
edition_fmv AS (
  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
  FROM fmv_snapshots
  WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL
  ORDER BY edition_id, computed_at DESC
),
owned_json AS (
  SELECT jsonb_agg(jsonb_build_object(
    'playId', u.external_id,
    'playerName', u.player_name,
    'tier', u.tier,
    'serialNumber', o.serial_number,
    'thumbnailUrl', u.thumbnail_url
  ) ORDER BY u.player_name) AS j
  FROM universe u
  JOIN owned o ON o.edition_id = u.edition_id
),
missing_json AS (
  SELECT jsonb_agg(jsonb_build_object(
    'playId', u.external_id,
    'playerName', u.player_name,
    'tier', u.tier,
    'fmvUsd', ef.fmv_usd,
    'thumbnailUrl', u.thumbnail_url
  ) ORDER BY ef.fmv_usd ASC NULLS LAST, u.player_name) AS j
  FROM universe u
  LEFT JOIN owned o ON o.edition_id = u.edition_id
  LEFT JOIN edition_fmv ef ON ef.edition_id = u.edition_id
  WHERE o.edition_id IS NULL
),
stats AS (
  SELECT
    COUNT(*)::int AS total_editions,
    COUNT(o.edition_id)::int AS owned_editions,
    COALESCE(SUM(CASE WHEN o.edition_id IS NULL THEN ef.fmv_usd ELSE 0 END), 0)::numeric(12,2) AS cost
  FROM universe u
  LEFT JOIN owned o ON o.edition_id = u.edition_id
  LEFT JOIN edition_fmv ef ON ef.edition_id = u.edition_id
)
SELECT jsonb_build_object(
  'setId', s.id,
  'setName', s.name,
  'setTier', s.tier::text,
  'totalPlays', st.total_editions,
  'ownedPlays', st.owned_editions,
  'missingPlays', st.total_editions - st.owned_editions,
  'completionPct', ROUND(100.0 * st.owned_editions::numeric / NULLIF(st.total_editions, 0), 1),
  'estimatedCostToComplete', st.cost,
  'owned', COALESCE(oj.j, '[]'::jsonb),
  'missing', COALESCE(mj.j, '[]'::jsonb)
)
FROM sets s
CROSS JOIN stats st
LEFT JOIN owned_json oj ON true
LEFT JOIN missing_json mj ON true
WHERE s.id = p_set_id
  AND s.collection_id = p_collection_id;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_allday_set_detail(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_allday_set_detail(text, uuid, uuid) TO authenticated, service_role, postgres;
