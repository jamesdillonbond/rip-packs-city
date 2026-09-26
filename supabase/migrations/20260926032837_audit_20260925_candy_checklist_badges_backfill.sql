-- audit_20260925_candy_checklist_badges_backfill
--
-- Candy MLB's published checklist marks 4 Rookie and 10 First Mint players
-- (docs/reference/candy-base-series-checklist-2026-07.csv). Drop 1 carries no
-- on-chain trait for either, so editions.badges held only the Rainbow colours.
-- The Solana normalizer now adds them (lib/chains/solana/candy-checklist.ts,
-- player-level: Core and Rainbow printings alike); this backfills the 15 existing
-- editions in the same order it produces: Rookie, First Mint, then the Rainbow tag.
--
-- Rollback: UPDATE editions SET badges = NULLIF(array(SELECT x FROM unnest(badges) x
--   WHERE x NOT IN ('Rookie','First Mint')), '{}')
--   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713';
--   (and revert the normalizer change, or the next ingest re-adds them)
WITH d(player, b) AS (VALUES
  ('Munetaka Murakami', ARRAY['Rookie','First Mint']), ('Chase DeLauter', ARRAY['Rookie','First Mint']),
  ('Kevin McGonigle', ARRAY['Rookie','First Mint']), ('Kazuma Okamoto', ARRAY['Rookie','First Mint']),
  ('Andy Pages', ARRAY['First Mint']), ('Jung Hoo Lee', ARRAY['First Mint']), ('Bryce Eldridge', ARRAY['First Mint']),
  ('Otto Lopez', ARRAY['First Mint']), ('José Soriano', ARRAY['First Mint']), ('Ben Rice', ARRAY['First Mint'])
)
UPDATE editions e
   SET badges = d.b || COALESCE(ARRAY(SELECT x FROM unnest(e.badges) x WHERE x <> ALL (d.b)), '{}')
  FROM d
 WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
   AND e.player_name = d.player;
