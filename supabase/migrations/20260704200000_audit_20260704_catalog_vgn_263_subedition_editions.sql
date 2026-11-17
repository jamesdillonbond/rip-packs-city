-- Catalog the Video Game Numbers (set 263) parallel editions (Hexwave=19 circ 25,
-- Jukebox=20 circ 10).
--
-- Found in the 2026-07-04 QA (sales-history vs Dapper): set 263 had ZERO `::` parallel
-- editions cataloged, so 362 parallel-moment sales/holdings were conflated onto the base
-- edition — e.g. Wemby nft 52203287 (Dapper: Hexwave #3/25) showed as base #3/284,
-- inflating base FMV with parallel-priced sales. Subedition ids were resolved on-chain via
-- TopShot.getMomentsSubedition(nftID) and stored durably in topshot_moment_subeditions
-- (the canonical nft_id -> base_external_id/subedition_id map, also the reverse map for revert).
--
-- Circulation = TS standard parallel sizes (Hexwave 25 / Jukebox 10), equal to the observed
-- max serials across the set and matching Dapper's supply. Art left NULL for the
-- subedition-aware art backfill. Idempotent (NOT EXISTS guard).
-- Revert: DELETE FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id ~ '^263:[0-9]+::(19|20)$';
INSERT INTO editions (
  id, external_id, collection_id, player_id, set_id, name, tier, series, edition_kind,
  circulation_count, badges, reward_indicators, thumbnail_url, video_url,
  play_type, play_category, game_date, home_team, away_team,
  first_minted_at, last_updated_at, created_at, updated_at,
  set_id_onchain, play_id_onchain, collection, player_name, set_name, team_name,
  jersey_number, subedition_id, subedition_name
)
SELECT
  gen_random_uuid(),
  b.external_id || '::' || t.subedition_id,
  b.collection_id, b.player_id, b.set_id, b.name, b.tier, b.series, b.edition_kind,
  CASE t.subedition_id WHEN 19 THEN 25 WHEN 20 THEN 10 END,
  b.badges, b.reward_indicators,
  NULL, NULL,
  b.play_type, b.play_category, b.game_date, b.home_team, b.away_team,
  b.first_minted_at, now(), now(), now(),
  b.set_id_onchain, b.play_id_onchain, b.collection, b.player_name, b.set_name, b.team_name,
  b.jersey_number, t.subedition_id,
  CASE t.subedition_id WHEN 19 THEN 'Hexwave' WHEN 20 THEN 'Jukebox' END
FROM (
  SELECT DISTINCT base_external_id, subedition_id
  FROM topshot_moment_subeditions
  WHERE base_external_id ~ '^263:[0-9]+$' AND subedition_id IN (19,20)
) t
JOIN editions b ON b.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND b.external_id = t.base_external_id
WHERE NOT EXISTS (
  SELECT 1 FROM editions x WHERE x.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND x.external_id = b.external_id || '::' || t.subedition_id
);
