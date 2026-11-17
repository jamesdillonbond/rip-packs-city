-- 2026-10-20 ~9:10 PM PT (Claude Code cloud) — Golazos: two different Luis Suárez on one player row.
--
-- Found by a read-only sweep: /laliga-golazos/player/luis-suarez listed five editions
-- under one player_id (400ad0fc-…), two of them UD Almería "Talentos" (external_id
-- 373, 259; 2023-01-27/28). Those are Luis Javier Suárez, the Colombian forward who
-- played for Almería in 2022-23 — not the Uruguayan (Barcelona 556/509, Atlético 173).
-- CLAUDE.md concierge rule 2: a NAME is not a PERSON.
--
-- The fix is one atomic statement: a new players row "Luis Javier Suárez" (distinct
-- name so its slug cannot win /luis-suarez — the current-team ranking would have
-- picked an Almería row by recency), the two editions repointed to it, and a
-- `namesake` player_relations row so the Uruguayan's page drops them from its name
-- fallback (edition_player_is_other_person, 20261021034822). editions.player_name
-- stays "Luis Suárez" (the league's label); the edition page links to the linked
-- row (player_page_name, 20261021040431).
--
-- Writer check before writing: no DB function and no Golazos ingest path rewrites
-- editions.player_id for existing editions (app/api/ingest is Top Shot only).

WITH np AS (
  INSERT INTO public.players (collection_id, collection, name, first_name, last_name, team, external_id, is_active)
  VALUES ('06248cc4-b85f-47cd-af67-1855d14acd75', 'laliga_golazos', 'Luis Javier Suárez', 'Luis Javier', 'Suárez',
          'UD Almería', 'laliga_golazos-luis-javier-suarez', false)
  RETURNING id
), up AS (
  UPDATE public.editions e SET player_id = np.id
    FROM np
   WHERE e.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
     AND e.external_id IN ('373', '259')
     AND e.player_id = '400ad0fc-5d9b-499f-8d33-28302ff89fe1'
     AND e.team_name = 'UD Almería'
  RETURNING e.external_id
), rel AS (
  INSERT INTO public.player_relations (collection_id, player_id, related_player_id, relation, note)
  SELECT '06248cc4-b85f-47cd-af67-1855d14acd75', np.id, '400ad0fc-5d9b-499f-8d33-28302ff89fe1', 'namesake',
         'Unrelated: Luis Javier Suárez is the Colombian forward (UD Almería 2022-23); Luis Suárez is the Uruguayan (Barcelona, Atlético de Madrid)'
    FROM np
  RETURNING id
)
SELECT (SELECT id FROM np) AS new_player_id, (SELECT count(*) FROM up) AS editions_repointed, (SELECT count(*) FROM rel) AS relations_added;

-- REVERT (one statement each, in order):
--   UPDATE public.editions SET player_id = '400ad0fc-5d9b-499f-8d33-28302ff89fe1'
--    WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75' AND external_id IN ('373','259');
--   DELETE FROM public.player_relations WHERE relation = 'namesake' AND related_player_id = '400ad0fc-5d9b-499f-8d33-28302ff89fe1';
--   DELETE FROM public.players WHERE external_id = 'laliga_golazos-luis-javier-suarez';
