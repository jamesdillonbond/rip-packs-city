-- 2026-10-20 ~10:35 PM PT (Claude Code cloud) — Panini: two different Luis Suárez on one
-- player row (known-issues #201). Same namesake pair as the Golazos split earlier tonight
-- (docs/audits/2026-10-20-golazos-luis-suarez-namesake-split.sql).
--
-- /panini-blockchain/player/luis-suarez listed 29 editions under players row 538b7294
-- (Uruguay's Luis Suárez). 18 are the Colombian forward Luis Javier Suárez, each placed by
-- its card's own team or its position in a team-ordered checklist:
--   product 1751 (LaLiga 2021-22)   Breakaway #14 ×2, International Men of Mastery #19 ×2
--                                   — a variant of each is tagged "Granada CF"
--   product 1918 (Ligue 1 2022-23)  Base Sapphire #179 — between Payet and Ünder (Marseille)
--   product 2002 (LaLiga 2023-24)   Base Terrace #81 ×3 — next to Arribas/Robertone (UD Almería)
--   product 2332 (2026 WC)          Base #186 ×10 — inside Colombia's run #180–191
-- The 11 that STAY are the Uruguayan's: 2018 Russia stickers #144, 2022 WC Prizm #280
-- (nation "Uruguay"), 1751 Base #16 (Atlético de Madrid run #11–21), 1751 Give and Go #3
-- (paired with Llorente #4, Atlético), and the 2026 legends inserts Prizmania #27 and
-- National Pride #39.
--
-- Run AFTER migration 20261021053313 (both Panini writers keep a namesake split). Before it,
-- the products bridge would have re-linked the repointed editions within 30 minutes.

WITH np AS (
  INSERT INTO public.players (collection_id, collection, name, first_name, last_name, external_id, is_active)
  VALUES ('d1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'panini_blockchain', 'Luis Javier Suárez', 'Luis Javier', 'Suárez',
          'panini-luis-javier-suarez', false)
  RETURNING id
), up AS (
  UPDATE public.editions e SET player_id = np.id
    FROM np
   WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     AND e.player_id = '538b7294-34b9-4d48-986e-ce9b8332d81b'
     AND e.external_id IN (
       'packcard-1751_333335_8399719_14', 'packcard-1751_333336_8396834_14',
       'packcard-1751_333340_8399286_19', 'packcard-1751_333341_8399326_19',
       'packcard-1918_371492_9332620_179',
       'packcard-2002_387256_10385357_81', 'packcard-2002_387262_10385057_81', 'packcard-2002_387797_10387157_81',
       'packcard-2332_487000_12687748_186', 'packcard-2332_486966_12578620_186', 'packcard-2332_486952_12683248_186',
       'packcard-2332_486953_12679248_186', 'packcard-2332_492193_12680248_186', 'packcard-2332_486956_12680748_186',
       'packcard-2332_486964_12579248_186', 'packcard-2332_486954_12677748_186', 'packcard-2332_486965_12678748_186',
       'packcard-2332_486967_12675248_186')
  RETURNING e.external_id
), rel AS (
  INSERT INTO public.player_relations (collection_id, player_id, related_player_id, relation, note)
  SELECT 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', np.id, '538b7294-34b9-4d48-986e-ce9b8332d81b', 'namesake',
         'Unrelated: Luis Javier Suárez is the Colombian forward (Granada CF, Marseille, UD Almería, Colombia); Luis Suárez is the Uruguayan (Atlético de Madrid, Uruguay)'
    FROM np
  RETURNING id
)
SELECT (SELECT id FROM np) AS new_player_id, (SELECT count(*) FROM up) AS editions_repointed, (SELECT count(*) FROM rel) AS relations_added;

-- REVERT (one statement each, in order):
--   UPDATE public.editions SET player_id = '538b7294-34b9-4d48-986e-ce9b8332d81b'
--    WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
--      AND player_id = (SELECT id FROM public.players WHERE external_id = 'panini-luis-javier-suarez');
--   DELETE FROM public.player_relations WHERE relation = 'namesake' AND related_player_id = '538b7294-34b9-4d48-986e-ce9b8332d81b';
--   DELETE FROM public.players WHERE external_id = 'panini-luis-javier-suarez';
