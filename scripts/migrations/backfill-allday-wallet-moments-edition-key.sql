-- Backfill wallet_moments_cache.edition_key for NFL All Day rows by joining
-- against nft_edition_map (populated by scripts/resolve-allday-buyers.ts).
--
-- Idempotent — only updates rows where edition_key IS NULL, so re-runs are
-- safe. Run after resolve-allday-buyers.ts has upserted fresh rows into
-- nft_edition_map.
--
-- Current state (2026-04-16):
--   total AllDay rows in cache:           3,705
--   already have edition_key:             3,682
--   missing edition_key (this backfill):     23

UPDATE wallet_moments_cache wmc
SET edition_key = nem.edition_external_id
FROM nft_edition_map nem
WHERE nem.collection_id = wmc.collection_id
  AND nem.nft_id = wmc.moment_id
  AND wmc.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND wmc.edition_key IS NULL;

-- Verification
SELECT
  count(*) FILTER (WHERE edition_key IS NULL) AS still_missing,
  count(*) FILTER (WHERE edition_key IS NOT NULL) AS resolved,
  count(*) AS total
FROM wallet_moments_cache
WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070';
