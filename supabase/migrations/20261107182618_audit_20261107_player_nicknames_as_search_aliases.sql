-- audit_20261107_player_nicknames_as_search_aliases
--
-- Rule 2 (a NAME is not a PERSON): the global search box resolves a typed name
-- through player_name_aliases — but the table held only SPELLING variants
-- (Steph/Stephen, Jr., II). Nicknames are what collectors actually type, and on
-- 2026-11-07 "dame" ranked Dameon Pierce and Radamel Falcao above Damian Lillard
-- (who appeared only as editions) and "wemby" returned no player at all.
--
-- 29 nicknames, each resolved against public.players on 2026-11-07 to EXACTLY
-- ONE row in its collection (matches=1 for all 29, none already aliased). Each
-- is a community name that belongs to one person in that collection; ambiguous
-- ones ("melo" → Carmelo AND LaMelo; "ja"; "ant") were deliberately left out.
-- The player_id is resolved BY NAME at apply time (never a pasted uuid), and a
-- name that does not resolve to exactly one row inserts nothing.
--
-- Idempotent: ON CONFLICT (collection_id, alias_slug) DO NOTHING.
-- Revert: DELETE FROM public.player_name_aliases WHERE note LIKE 'audit_20261107 nickname%';

INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
SELECT c.id, w.alias, p.id, 'audit_20261107 nickname: ' || w.nm
FROM (VALUES
  ('nba_top_shot','dame','Damian Lillard'),
  ('nba_top_shot','wemby','Victor Wembanyama'),
  ('nba_top_shot','greek-freak','Giannis Antetokounmpo'),
  ('nba_top_shot','the-joker','Nikola Jokić'),
  ('nba_top_shot','sga','Shai Gilgeous-Alexander'),
  ('nba_top_shot','king-james','LeBron James'),
  ('nba_top_shot','kd','Kevin Durant'),
  ('nba_top_shot','cp3','Chris Paul'),
  ('nba_top_shot','dlo','D''Angelo Russell'),
  ('nba_top_shot','jimmy-buckets','Jimmy Butler III'),
  ('nba_top_shot','spida','Donovan Mitchell'),
  ('nba_top_shot','chef-curry','Steph Curry'),
  ('nba_top_shot','pg13','Paul George'),
  ('nba_top_shot','the-beard','James Harden'),
  ('nba_top_shot','ant-man','Anthony Edwards'),
  ('nba_top_shot','the-brow','Anthony Davis'),
  ('nba_top_shot','kat','Karl-Anthony Towns'),
  ('nba_top_shot','the-process','Joel Embiid'),
  ('nfl_all_day','cmc','Christian McCaffrey'),
  ('nfl_all_day','obj','Odell Beckham Jr.'),
  ('nfl_all_day','megatron','Calvin Johnson'),
  ('nfl_all_day','tua','Tua Tagovailoa'),
  ('nfl_all_day','jjettas','Justin Jefferson'),
  ('nfl_all_day','ceedee','CeeDee Lamb'),
  ('ufc_strike','the-notorious','Conor McGregor'),
  ('ufc_strike','bones','Jon Jones'),
  ('ufc_strike','poatan','Alex Pereira'),
  ('ufc_strike','stylebender','Israel Adesanya'),
  ('ufc_strike','the-eagle','Khabib Nurmagomedov')
) AS w(coll, alias, nm)
JOIN public.collections c ON c.slug = w.coll
JOIN LATERAL (
  SELECT (array_agg(p1.id))[1] AS id FROM public.players p1
  WHERE p1.collection_id = c.id AND p1.name = w.nm
  HAVING count(*) = 1
) p ON true
ON CONFLICT (collection_id, alias_slug) DO NOTHING;
