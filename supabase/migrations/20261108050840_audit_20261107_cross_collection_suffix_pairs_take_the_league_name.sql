-- audit_20261107_cross_collection_suffix_pairs_take_the_league_name
--
-- 2026-11-07 ~9:05 PM PT (Claude Code cloud; Trevor: "Keep going"). Second NFL /
-- NBA batch under Trevor's 4:59 PM rule (one person, one name: the league page's).
--
-- WHAT WAS WRONG. 25 people carried a different generational suffix in different
-- collections ("Calvin Austin" on All Day, "Calvin Austin III" on Panini; "Bronny
-- James" on Top Shot, "Bronny James Jr." on Panini) with NO alias linking them,
-- so the cross-collection hub, search and the concierge treated them as two
-- people. Found by comparing names with the suffix (Jr/Sr/II/III/IV) stripped
-- across Top Shot, All Day and Panini, excluding pairs already aliased or with a
-- recorded parent/namesake relation, then checking each pair is ONE person (same
-- sport, same team/era).
--
-- THE NAME. The heading of each player's nfl.com / nba.com page, fetched 11-07.
-- Renamed (old → new): All Day — Calvin Austin III, Chris Rodriguez Jr., Dante
-- Fowler Jr., Gervon Dexter Sr., Harold Fannin Jr., Joe Milton III, John Metchie
-- III, Kelvin Banks Jr., Luther Burden III, Ollie Gordon II, Shavon Revel Jr.,
-- Tyrone Tracy Jr., Will McDonald IV (suffix added); Top Shot — Harry Giles III;
-- Panini — Bronny James, Darnell Savage, Darrick Forrest, Devin Bush, KJ Simpson,
-- Mark Ingram, Mecole Hardman, Pierre Strong, Terence Davis, Terry Rozier, Tre
-- Johnson (suffix dropped). 114 editions, asserted per player and in total; each
-- old spelling kept as an alias in its own collection; player_identities
-- display_name follows. Panini "Terry Rozier" was an EMPTY row (0 editions, no
-- relations / identities / aliases) beside "Terry Rozier III"; it is deleted
-- before the rename.
--
-- LEFT ALONE, on purpose: different people with one base name (Panini "Gary
-- Payton" / "Tim Hardaway" are the fathers' Legends / USA cards vs Top Shot's
-- II / Jr.; Panini "Andre Jackson" is a baseball player; NBA Troy Brown Jr. vs the
-- Patriots' Troy Brown); and three not settled from a page heading alone — Kris
-- Jenkins Jr. (nfl.com shows the son as "Kris Jenkins", the same heading as his
-- father, so dropping the "Jr." would merge them on the hub), Jeremiah Trotter
-- (All Day's "Career Chronicles" card may be the father) and Mike Haynes (All
-- Day "Mike Haynes Jr." on a Raiders Vintage card vs Panini "Mike Haynes").
--
-- VERIFIED AT APPLY: check_player_alias_integrity() 0/0/0; resolve_player_name
-- maps "Bronny James Jr.", "Terry Rozier III", "Calvin Austin", "Harry Giles" to
-- the new names in each collection that has them.
--
-- anon-exec: none — no function created.
--
-- REVERT: the loop with old/new swapped, then
--   DELETE FROM player_name_aliases WHERE note = 'audit_20261107 league name (batch 2)';

DO $mig$
DECLARE
  r record;
  v_coll uuid;
  v_n int;
  v_total int := 0;
  v_old_slug text;
  v_sep text;
BEGIN
  -- Panini "Terry Rozier": an EMPTY row (0 editions, no relations / identities /
  -- aliases) beside the real "Terry Rozier III". It goes first so the rename below
  -- does not mint a second "Terry Rozier".
  PERFORM 1 FROM public.players
   WHERE id = 'b0d0a181-24ca-4acd-a683-161c95de098f' AND name = 'Terry Rozier'
     AND NOT EXISTS (SELECT 1 FROM public.editions e WHERE e.player_id = 'b0d0a181-24ca-4acd-a683-161c95de098f')
     AND NOT EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.player_id = 'b0d0a181-24ca-4acd-a683-161c95de098f');
  IF NOT FOUND THEN RAISE EXCEPTION 'empty Panini Terry Rozier row changed; re-read'; END IF;
  DELETE FROM public.players WHERE id = 'b0d0a181-24ca-4acd-a683-161c95de098f';

  FOR r IN
    SELECT * FROM (VALUES
      ('nba_top_shot',      'c36cb969-b8b0-4b50-af08-ffef1e1b7ec9'::uuid, 'Harry Giles',        'Harry Giles III',      2),
      ('nfl_all_day',       '28d60381-3187-4ca1-91d9-e6da8976017e'::uuid, 'Calvin Austin',      'Calvin Austin III',    1),
      ('nfl_all_day',       '3d101d08-4b92-4a00-b0f9-fc61529170a1'::uuid, 'Chris Rodriguez',    'Chris Rodriguez Jr.',  1),
      ('nfl_all_day',       '7e219481-a7c2-46bc-a34b-a24472ecd247'::uuid, 'Dante Fowler',       'Dante Fowler Jr.',     1),
      ('nfl_all_day',       '621a15b1-7abe-4cb2-aa78-8d2515f932c9'::uuid, 'Gervon Dexter',      'Gervon Dexter Sr.',    1),
      ('nfl_all_day',       '77111b03-a52c-4a6e-a538-c8d5b0a96373'::uuid, 'Harold Fannin',      'Harold Fannin Jr.',    3),
      ('nfl_all_day',       '3810dc6d-c4fe-4583-8797-11eeb9d3f56b'::uuid, 'Joe Milton',         'Joe Milton III',       1),
      ('nfl_all_day',       '03525e5b-298b-4309-8818-98501cebd4fe'::uuid, 'John Metchie',       'John Metchie III',     1),
      ('nfl_all_day',       'e554868d-71a9-4c74-af0c-883e5013a491'::uuid, 'Kelvin Banks',       'Kelvin Banks Jr.',     1),
      ('nfl_all_day',       '0b11ebe3-ceff-49ea-b00d-825d704aba41'::uuid, 'Luther Burden',      'Luther Burden III',    3),
      ('nfl_all_day',       'e8e098b4-1b8a-445c-a71d-8dd0f429a6a5'::uuid, 'Ollie Gordon',       'Ollie Gordon II',      1),
      ('nfl_all_day',       'cc0864be-acd2-4230-a27e-795a2daf78da'::uuid, 'Shavon Revel',       'Shavon Revel Jr.',     1),
      ('nfl_all_day',       'cec8a3c5-14b8-432b-a024-cca9fb61a9e2'::uuid, 'Tyrone Tracy',       'Tyrone Tracy Jr.',     3),
      ('nfl_all_day',       'd067be5e-2109-4e91-97a7-ff07f86b9cac'::uuid, 'Will McDonald',      'Will McDonald IV',     3),
      ('panini_blockchain', 'cd0ceb40-3733-4df7-baf5-667fc408b267'::uuid, 'Bronny James Jr.',   'Bronny James',        31),
      ('panini_blockchain', 'd24710d0-7b43-479a-ad21-f4590b8980af'::uuid, 'Darnell Savage Jr.', 'Darnell Savage',       7),
      ('panini_blockchain', '3429e1d8-188e-473e-8efe-44b416986355'::uuid, 'Darrick Forrest Jr.','Darrick Forrest',      2),
      ('panini_blockchain', '41f90443-fef0-40c4-a0ea-700e944069b5'::uuid, 'Devin Bush II',      'Devin Bush',           1),
      ('panini_blockchain', 'dcefdc45-9e6f-43d1-b5a4-bac395705787'::uuid, 'KJ Simpson Jr.',     'KJ Simpson',           1),
      ('panini_blockchain', '4b26f629-2c5a-45c9-8eaf-c3087dece0ed'::uuid, 'Mark Ingram II',     'Mark Ingram',          4),
      ('panini_blockchain', '9835a02f-fcc2-43ba-86d9-8bab7b8712b8'::uuid, 'Mecole Hardman Jr.', 'Mecole Hardman',       7),
      ('panini_blockchain', 'cc2e30a1-efdb-4c41-bcb5-c9b73faa6b63'::uuid, 'Pierre Strong Jr.',  'Pierre Strong',        6),
      ('panini_blockchain', '0790d7e2-a3e4-4b09-a778-edc51d3fa9d9'::uuid, 'Terence Davis II',   'Terence Davis',        8),
      ('panini_blockchain', 'e9ad0cbf-5c81-4fc9-a096-590d0f3a6560'::uuid, 'Terry Rozier III',   'Terry Rozier',        19),
      ('panini_blockchain', '0a0bd622-cf7b-4d74-a724-0b34b6cc491c'::uuid, 'Tre Johnson III',    'Tre Johnson',          5)
    ) v(coll, pid, old_name, new_name, expect_eds)
  LOOP
    SELECT p.collection_id INTO v_coll FROM public.players p
      JOIN public.collections c ON c.id = p.collection_id AND c.slug = r.coll
     WHERE p.id = r.pid AND p.name = r.old_name;
    IF v_coll IS NULL THEN RAISE EXCEPTION '% (%) moved or renamed; re-read before applying', r.old_name, r.coll; END IF;

    SELECT count(*) INTO v_n FROM public.players
     WHERE collection_id = v_coll AND id <> r.pid
       AND lower(extensions.unaccent(name)) = lower(extensions.unaccent(r.new_name));
    IF v_n <> 0 THEN RAISE EXCEPTION '% already exists in % (% rows); merge instead', r.new_name, r.coll, v_n; END IF;

    v_old_slug := regexp_replace(lower(btrim(extensions.unaccent(r.old_name))), '[^a-z0-9]+', '-', 'g');
    SELECT count(*) INTO v_n FROM public.player_name_aliases
     WHERE collection_id = v_coll AND btrim(alias_slug, '-') = btrim(v_old_slug, '-');
    IF v_n <> 0 THEN RAISE EXCEPTION '% alias % already present', r.coll, v_old_slug; END IF;

    v_sep := CASE WHEN r.coll = 'panini_blockchain' THEN ' - ' ELSE ' — ' END;

    UPDATE public.players SET name = r.new_name, updated_at = now() WHERE id = r.pid;
    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
    VALUES (v_coll, v_old_slug, r.pid, 'audit_20261107 league name (batch 2)');
    UPDATE public.player_identities SET display_name = r.new_name WHERE player_id = r.pid;

    UPDATE public.editions
       SET player_name = CASE WHEN player_name = r.old_name THEN r.new_name ELSE player_name END,
           name        = CASE WHEN name LIKE r.old_name || v_sep || '%'
                              THEN r.new_name || substr(name, length(r.old_name) + 1) ELSE name END,
           updated_at  = now()
     WHERE player_id = r.pid
       AND (player_name = r.old_name OR name LIKE r.old_name || v_sep || '%');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> r.expect_eds THEN RAISE EXCEPTION '%: expected % editions, updated %', r.old_name, r.expect_eds, v_n; END IF;
    v_total := v_total + v_n;
  END LOOP;
  IF v_total <> 114 THEN RAISE EXCEPTION 'expected 114 edition rows in total, updated %', v_total; END IF;
END
$mig$;
