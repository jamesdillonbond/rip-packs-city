-- 2026-05-10: Hydrate UFC stub editions' player_id + set_id linkage.
--
-- 299 of 446 UFC edition rows were auto-stubbed from the external_id key
-- and had player_name + set_name populated but NULL player_id + NULL set_id.
-- Already-shipped path: search_catalog_all falls back to editions text
-- columns, but other RPCs that JOIN through players/sets miss these rows.
--
-- Strategy (idempotent, ON CONFLICT DO NOTHING for the inserts):
--   1. Link existing UFC players by case-insensitive trimmed name.
--   2. Insert missing players with external_id slug 'ufc_strike-<name-slug>'
--      and collection='ufc_strike' (matches the existing convention).
--   3. Link the just-inserted players to remaining-NULL editions.
--   4. Same dance for sets, with external_id slug 'ufc_strike-set-<name-slug>'
--      so it doesn't collide with the global UNIQUE on sets.external_id
--      (existing UFC sets are bare slugs: 'contender' / 'challenger' / 'fandom').

-- Phase 1a: link to existing UFC players by name.
UPDATE editions e
SET player_id = p.id
FROM players p
WHERE e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
  AND e.player_id IS NULL
  AND p.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
  AND lower(btrim(p.name)) = lower(btrim(e.player_name));

-- Phase 2a: insert missing players.
WITH missing AS (
  SELECT DISTINCT
    btrim(player_name) AS clean_name,
    'ufc_strike-' || regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g') AS slug
  FROM editions
  WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
    AND player_id IS NULL
    AND player_name IS NOT NULL
    AND btrim(player_name) <> ''
)
INSERT INTO players (external_id, collection_id, name, collection)
SELECT m.slug, '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid, m.clean_name, 'ufc_strike'
FROM missing m
ON CONFLICT (external_id) DO NOTHING;

-- Phase 1b: re-link UFC editions still NULL after the insert.
UPDATE editions e
SET player_id = p.id
FROM players p
WHERE e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
  AND e.player_id IS NULL
  AND p.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
  AND p.external_id = 'ufc_strike-' || regexp_replace(lower(btrim(e.player_name)), '[^a-z0-9]+', '-', 'g');

-- Phase 1c: link existing UFC sets by name.
UPDATE editions e
SET set_id = s.id
FROM sets s
WHERE e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
  AND e.set_id IS NULL
  AND s.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
  AND lower(btrim(s.name)) = lower(btrim(e.set_name));

-- Phase 2b: insert missing UFC sets.
WITH missing AS (
  SELECT DISTINCT
    btrim(set_name) AS clean_name,
    'ufc_strike-set-' || regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g') AS slug
  FROM editions
  WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
    AND set_id IS NULL
    AND set_name IS NOT NULL
    AND btrim(set_name) <> ''
)
INSERT INTO sets (external_id, collection_id, name)
SELECT m.slug, '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid, m.clean_name
FROM missing m
ON CONFLICT (external_id) DO NOTHING;

-- Phase 1d: re-link UFC editions still NULL.
UPDATE editions e
SET set_id = s.id
FROM sets s
WHERE e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
  AND e.set_id IS NULL
  AND s.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
  AND s.external_id = 'ufc_strike-set-' || regexp_replace(lower(btrim(e.set_name)), '[^a-z0-9]+', '-', 'g');
