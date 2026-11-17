-- audit_20261107_panini_nfl_players_take_the_nfl_name
--
-- 2026-11-07 ~9:00 PM PT (Claude Code cloud; Trevor: "Keep going"). Extends
-- Trevor's 4:59 PM rule — one person, one name, the one the league's own page
-- uses — from the NBA/WNBA pairs to the NFL.
--
-- WHAT WAS WRONG. Thirteen NFL players carried Panini's spelling on Panini and
-- the NFL's on All Day, so one person had two hub URLs (/players/patrick-mahomes
-- AND /players/patrick-mahomes-ii, both indexable, both self-canonical), two
-- search hits, and two names across the site. Found by joining every
-- player_name_aliases row to players in OTHER collections named that alias.
--
-- THE NAME. nfl.com's player-page heading, read 11-07 for all 14: in every case
-- it equals All Day's name, so only Panini rows change —
--   Allen Robinson II → Allen Robinson · Brian Robinson Jr. → Brian Robinson ·
--   Chigoziem Okonkwo → Chig Okonkwo · Darius Slay Jr. → Darius Slay ·
--   Derwin James Jr. → Derwin James · Eli Mitchell → Elijah Mitchell ·
--   Gabriel Davis → Gabe Davis · Gardner Minshew II → Gardner Minshew ·
--   Marvin Mims → Marvin Mims Jr. · Matt Judon → Matthew Judon ·
--   Patrick Mahomes II → Patrick Mahomes · Tariq Woolen → Riq Woolen ·
--   Travis Etienne Jr. → Travis Etienne
-- and "Decobie Durant" was an EMPTY Panini row (0 editions) beside the real
-- Panini "Cobie Durant": its spelling becomes an alias of Cobie Durant and the
-- empty row is deleted (no editions, relations or identities referenced it).
--
-- WHAT CHANGES (runbook: docs/reference/player-identity.md "Renaming a player"):
-- players.name; editions.player_name and the " - " house label (298 rows,
-- asserted per player and in total); a Panini alias row for each old spelling.
-- Multi-player cards ("Patrick Mahomes II | Travis Kelce") keep Panini's label.
-- Panini's own tables keep the raw spelling; readers match both (20261108014421,
-- the concierge's slug match).
--
-- VERIFIED AT APPLY: check_player_alias_integrity() 0/0/0; resolve_player_name on
-- Panini maps "Patrick Mahomes II", "Tariq Woolen", "Decobie Durant",
-- "Travis Etienne Jr." to the new names.
--
-- anon-exec: none — no function created.
--
-- REVERT: the same loop with old/new swapped and
--   DELETE FROM player_name_aliases WHERE note LIKE 'audit_20261107 nfl.com name%';
-- (Decobie Durant: re-insert only if a Panini card ever carries that spelling.)

DO $mig$
DECLARE
  r record;
  v_coll constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_n int;
  v_total int := 0;
  v_old_slug text;
  v_twin uuid;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('d33de642-68c2-4d4f-942b-ce183974cf7f'::uuid, 'Allen Robinson II',  'Allen Robinson',   10),
      ('ed6b3bb1-fe57-497f-98fd-48a81846cffb'::uuid, 'Brian Robinson Jr.', 'Brian Robinson',   13),
      ('2293be9e-59cf-4da9-8f7e-bd5546108bb8'::uuid, 'Chigoziem Okonkwo',  'Chig Okonkwo',      2),
      ('8619c00b-6cf5-4861-b535-1e8cce14cff9'::uuid, 'Darius Slay Jr.',    'Darius Slay',      16),
      ('d227780d-9c22-4c31-95ff-3c76362e53d4'::uuid, 'Derwin James Jr.',   'Derwin James',     13),
      ('5054fdbc-1e97-4e92-bc33-9c3e04b45d98'::uuid, 'Eli Mitchell',       'Elijah Mitchell',  11),
      ('6f1a85e5-9100-4cce-921f-b0dd5ea76400'::uuid, 'Gabriel Davis',      'Gabe Davis',       13),
      ('dad86354-80ac-4141-bf4f-5f3261b880bf'::uuid, 'Gardner Minshew II', 'Gardner Minshew',  10),
      ('0dfab0d4-f0b4-4c20-8af2-095335183769'::uuid, 'Marvin Mims',        'Marvin Mims Jr.',  12),
      ('6029bb03-1483-4d30-a267-1ed8420f6f48'::uuid, 'Matt Judon',         'Matthew Judon',     7),
      ('7f568a25-5b15-4f1c-abfe-a8826e6b5a97'::uuid, 'Patrick Mahomes II', 'Patrick Mahomes', 152),
      ('d5060146-9bb2-43f0-bdbf-25a4bc22b424'::uuid, 'Tariq Woolen',       'Riq Woolen',        5),
      ('38594614-b148-4fd8-ae7d-62a827bd3700'::uuid, 'Travis Etienne Jr.', 'Travis Etienne',   34)
    ) v(pid, old_name, new_name, expect_eds)
  LOOP
    PERFORM 1 FROM public.players WHERE id = r.pid AND collection_id = v_coll AND name = r.old_name;
    IF NOT FOUND THEN RAISE EXCEPTION '% moved or renamed; re-read before applying', r.old_name; END IF;

    SELECT count(*) INTO v_n FROM public.players
     WHERE collection_id = v_coll AND id <> r.pid
       AND lower(extensions.unaccent(name)) = lower(extensions.unaccent(r.new_name));
    IF v_n <> 0 THEN RAISE EXCEPTION '% already exists on Panini (% rows); merge instead', r.new_name, v_n; END IF;

    v_old_slug := regexp_replace(lower(btrim(extensions.unaccent(r.old_name))), '[^a-z0-9]+', '-', 'g');
    SELECT count(*) INTO v_n FROM public.player_name_aliases
     WHERE collection_id = v_coll AND btrim(alias_slug, '-') = btrim(v_old_slug, '-');
    IF v_n <> 0 THEN RAISE EXCEPTION 'Panini alias % already present', v_old_slug; END IF;

    UPDATE public.players SET name = r.new_name, updated_at = now() WHERE id = r.pid;
    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
    VALUES (v_coll, v_old_slug, r.pid, 'audit_20261107 nfl.com name');

    UPDATE public.editions
       SET player_name = CASE WHEN player_name = r.old_name THEN r.new_name ELSE player_name END,
           name        = CASE WHEN name LIKE r.old_name || ' - %'
                              THEN r.new_name || substr(name, length(r.old_name) + 1) ELSE name END,
           updated_at  = now()
     WHERE player_id = r.pid
       AND (player_name = r.old_name OR name LIKE r.old_name || ' - %');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> r.expect_eds THEN RAISE EXCEPTION '%: expected % editions, updated %', r.old_name, r.expect_eds, v_n; END IF;
    v_total := v_total + v_n;
  END LOOP;
  IF v_total <> 298 THEN RAISE EXCEPTION 'expected 298 edition rows in total, updated %', v_total; END IF;

  -- "Decobie Durant": an EMPTY Panini row (0 editions) beside the real "Cobie Durant".
  -- Its spelling becomes an alias of Cobie Durant; the empty row goes.
  SELECT id INTO v_twin FROM public.players WHERE collection_id = v_coll AND name = 'Cobie Durant';
  IF v_twin IS NULL THEN RAISE EXCEPTION 'Panini Cobie Durant not found'; END IF;
  PERFORM 1 FROM public.players WHERE id = '5cf06c95-863f-4e32-b72d-198e560e8ccc' AND name = 'Decobie Durant'
     AND NOT EXISTS (SELECT 1 FROM public.editions e WHERE e.player_id = '5cf06c95-863f-4e32-b72d-198e560e8ccc');
  IF NOT FOUND THEN RAISE EXCEPTION 'Decobie Durant row changed or gained editions; re-read'; END IF;
  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
  VALUES (v_coll, 'decobie-durant', v_twin, 'audit_20261107 nfl.com name (empty twin removed)');
  DELETE FROM public.players WHERE id = '5cf06c95-863f-4e32-b72d-198e560e8ccc';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'Decobie Durant delete removed % rows', v_n; END IF;
END
$mig$;
