-- Hydrate editions.player_name for Disney Pinnacle rows whose player_name is
-- currently 'Unknown' (or blank/null) by copying character_name from the
-- first available source:
--   1. pinnacle_editions.character_name (edition_key match)
--   2. wallet_moments_cache.character_name (collection + edition_key match)
--   3. pinnacle_cached_listings.character_name (edition_key match)
--
-- Each candidate is NULLIF'd against 'Unknown' so a lower-priority fallback
-- wins only when the higher-priority source itself has Unknown. Idempotent —
-- re-running on the same data is a no-op.
--
-- Current data picture: only ~1 row of the 211 Unknown rows is hydratable
-- today, because the upstream Pinnacle GraphQL metadata still returns
-- 'Unknown' for the other 210 edition_keys across all four internal mirrors.
-- The migration is intentionally generic so it self-heals as upstream data
-- gets backfilled by the existing pinnacle-sync pipeline.

WITH best AS (
  SELECT
    e.id AS edition_id,
    COALESCE(
      NULLIF(pe.character_name, 'Unknown'),
      NULLIF(wmc_ek.character_name, 'Unknown'),
      NULLIF(pcl.character_name, 'Unknown')
    ) AS new_name
  FROM editions e
  LEFT JOIN pinnacle_editions pe
    ON pe.edition_key = e.external_id
  LEFT JOIN LATERAL (
    SELECT character_name
    FROM wallet_moments_cache
    WHERE collection_id = e.collection_id
      AND edition_key = e.external_id
      AND character_name IS NOT NULL
      AND character_name NOT IN ('', 'Unknown')
    LIMIT 1
  ) wmc_ek ON TRUE
  LEFT JOIN LATERAL (
    SELECT character_name
    FROM pinnacle_cached_listings
    WHERE edition_key = e.external_id
      AND character_name IS NOT NULL
      AND character_name NOT IN ('', 'Unknown')
    LIMIT 1
  ) pcl ON TRUE
  WHERE e.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
    AND (e.player_name IS NULL OR e.player_name = '' OR e.player_name = 'Unknown')
)
UPDATE editions e
SET
  player_name = best.new_name,
  updated_at = NOW()
FROM best
WHERE e.id = best.edition_id
  AND best.new_name IS NOT NULL;
