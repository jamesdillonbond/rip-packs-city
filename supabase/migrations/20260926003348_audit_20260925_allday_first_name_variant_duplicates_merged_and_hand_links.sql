-- 2026-09-25 (PT) — the crosswalk's second finding: 15 All Day players existed
-- TWICE under a first-name variant ("Joseph Flacco" beside "Joe Flacco",
-- "Gabriel Davis" / "Gabe Davis", "Tariq Woolen" / "Riq Woolen", "Mar'Keise
-- Irving" / "Bucky Irving", a malformed "Antoine Jr. Winfield" beside "Antoine
-- Winfield Jr." …) — invisible to every earlier merge (exact name, accent,
-- suffix) and visible now because match_player_identities linked the league
-- spelling and left the variant unmatched. Merged into the league-spelt row
-- (the one the crosswalk already keys), the variant slug registered as an
-- alias so its URL 308s, backups in the batch-44 audit tables.
--
-- And 23 rows the matcher could not settle by rule are linked BY HAND against
-- nflverse (a Chris Johnson among seven, the Titans RB; Chad Johnson the
-- Bengals WR; Steve Smith Sr. the Panthers WR; …), names kept as All Day
-- spells them, the league spelling registered as an alias where it differs
-- ("kenny-gainwell" → Kenneth Gainwell). ⚠ No renames here: nflverse spells
-- some legends unlike NFL.com ("Mike Vick"), so a rename is Trevor's call.
--
-- Revert: players/editions from audit_20260925_suffix_players_backup /
-- audit_20260925_suffix_editions_backup (rows stamped now()); DELETE FROM
-- player_name_aliases WHERE note LIKE 'batch 51%'; UPDATE player_identities
-- SET player_id = NULL, matched_by = NULL WHERE matched_by = 'hand:2026-09-25'.

DO $$
DECLARE
  r RECORD;
  v_keep uuid; v_drop uuid; v_moved int; v_n int;
  v_coll uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_slug text;
BEGIN
  -- (1) the fifteen merges: variant → league-spelt row
  FOR r IN SELECT * FROM (VALUES
      ('Joseph Flacco',        'Joe Flacco'),
      ('Gabriel Davis',        'Gabe Davis'),
      ('Gregory Rousseau',     'Greg Rousseau'),
      ('Tariq Woolen',         'Riq Woolen'),
      ('Eli Mitchell',         'Elijah Mitchell'),
      ('Chigoziem Okonkwo',    'Chig Okonkwo'),
      ('LaDanian Tomlinson',   'LaDainian Tomlinson'),
      ('Demeioun Robinson',    'Chop Robinson'),
      ('Decobie Durant',       'Cobie Durant'),
      ('Matt Judon',           'Matthew Judon'),
      ('Justin Madubuike',     'Nnamdi Madubuike'),
      ('Andrew McConkey',      'Ladd McConkey'),
      ('Nathaniel Wiggins',    'Nate Wiggins'),
      ('Mar''Keise Irving',    'Bucky Irving'),
      ('Antoine Jr. Winfield', 'Antoine Winfield Jr.')
    ) v(drop_name, keep_name)
  LOOP
    SELECT id INTO v_keep FROM public.players WHERE collection_id = v_coll AND name = r.keep_name;
    SELECT id INTO v_drop FROM public.players WHERE collection_id = v_coll AND name = r.drop_name;
    IF v_keep IS NULL THEN RAISE EXCEPTION 'batch 51: keep row "%" not found', r.keep_name; END IF;
    IF v_drop IS NULL THEN RAISE NOTICE 'batch 51: "%" already gone', r.drop_name; CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = v_keep) THEN
      RAISE EXCEPTION 'batch 51: keep row "%" is not the crosswalk-keyed row', r.keep_name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect WHERE player_id = v_drop)
       OR EXISTS (SELECT 1 FROM public.panini_bridge_candidate_editions WHERE player_id = v_drop)
       OR EXISTS (SELECT 1 FROM public.badge_editions WHERE player_id = v_drop::text) THEN
      RAISE EXCEPTION 'batch 51: "%" is referenced outside editions', r.drop_name;
    END IF;
    INSERT INTO public.audit_20260925_suffix_players_backup SELECT p.*, now() FROM public.players p WHERE p.id = v_drop;
    INSERT INTO public.audit_20260925_suffix_editions_backup (edition_id, player_id)
      SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id = v_drop
      ON CONFLICT (edition_id) DO NOTHING;
    UPDATE public.editions SET player_id = v_keep WHERE player_id = v_drop;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    UPDATE public.player_name_aliases SET player_id = v_keep WHERE player_id = v_drop;
    DELETE FROM public.players WHERE id = v_drop;
    v_slug := regexp_replace(lower(trim(extensions.unaccent(r.drop_name))), '[^a-z0-9]+', '-', 'g');
    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
      VALUES (v_coll, v_slug, v_keep, 'batch 51 2026-09-25: first-name variant of ' || r.keep_name)
      ON CONFLICT (collection_id, alias_slug) DO NOTHING;
    RAISE NOTICE 'batch 51: merged "%" into "%": % editions', r.drop_name, r.keep_name, v_moved;
  END LOOP;

  -- (2) the hand links: All Day row (name kept) → nflverse identity
  FOR r IN SELECT * FROM (VALUES
      ('Kenneth Gainwell', '00-0036919', 'Kenny Gainwell'),
      ('D.J. Reader',      '00-0032424', 'DJ Reader'),
      ('P.J. Walker',      '00-0033275', 'PJ Walker'),
      ('CJ West',          '00-0040711', 'C.J. West'),
      ('J.C. Latham',      '00-0039731', 'JC Latham'),
      ('Joshua Simmons',   '00-0040116', 'Josh Simmons'),
      ('JT Tuimoloau',     '00-0040744', 'Jaylahn Tuimoloau'),
      ('Beanie Wells',     '00-0027007', 'Chris Wells'),
      ('Michael Vick',     '00-0020245', 'Mike Vick'),
      ('Scotty Miller',    '00-0035298', 'Scott Miller'),
      ('Herm Edwards',     'EDW492192',  'Herman Edwards'),
      ('Steve Smith Sr.',  '00-0020337', 'Steve Smith'),
      ('Robby Anderson',   '00-0032688', 'Robbie Chosen'),
      ('Chad Johnson',     '00-0020397', NULL),
      ('Chris Johnson',    '00-0026164', NULL),
      ('Ricky Williams',   '00-0017915', NULL),
      ('Kevin Williams',   '00-0022073', NULL),
      ('Roy Williams',     '00-0022909', NULL),
      ('Steven Jackson',   '00-0022736', NULL),
      ('Alex Smith',       '00-0023436', NULL),
      ('Josh Johnson',     '00-0026300', NULL),
      ('Jaylon Jones',     '00-0038407', NULL),
      ('Brian Mitchell',   '00-0011399', NULL)
    ) v(rpc_name, gsis, league_name)
  LOOP
    SELECT count(*) INTO v_n FROM public.players WHERE collection_id = v_coll AND name = r.rpc_name;
    IF v_n <> 1 THEN RAISE EXCEPTION 'batch 51: % rows named "%"', v_n, r.rpc_name; END IF;
    SELECT id INTO v_keep FROM public.players WHERE collection_id = v_coll AND name = r.rpc_name;
    IF EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = v_keep) THEN
      RAISE NOTICE 'batch 51: "%" already keyed', r.rpc_name; CONTINUE;
    END IF;
    UPDATE public.player_identities i
       SET player_id = v_keep, matched_by = 'hand:2026-09-25', matched_at = now()
     WHERE i.league = 'nfl' AND i.league_player_id = r.gsis AND i.player_id IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'batch 51: identity % for "%" not free', r.gsis, r.rpc_name; END IF;
    IF r.league_name IS NOT NULL THEN
      v_slug := regexp_replace(lower(trim(extensions.unaccent(r.league_name))), '[^a-z0-9]+', '-', 'g');
      IF NOT EXISTS (SELECT 1 FROM public.players p WHERE p.collection_id = v_coll
                       AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug) THEN
        INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
          VALUES (v_coll, v_slug, v_keep, 'batch 51 2026-09-25: league spelling of ' || r.rpc_name)
          ON CONFLICT (collection_id, alias_slug) DO NOTHING;
      END IF;
    END IF;
  END LOOP;
END $$;

-- Post-conditions
DO $$
DECLARE v_n int; r jsonb;
BEGIN
  SELECT count(*) INTO v_n FROM public.players
   WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
     AND name IN ('Joseph Flacco','Gabriel Davis','Gregory Rousseau','Tariq Woolen','Eli Mitchell','Chigoziem Okonkwo',
                  'LaDanian Tomlinson','Demeioun Robinson','Decobie Durant','Matt Judon','Justin Madubuike','Andrew McConkey',
                  'Nathaniel Wiggins','Mar''Keise Irving','Antoine Jr. Winfield');
  IF v_n <> 0 THEN RAISE EXCEPTION 'batch 51: % variant rows remain', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.player_identities WHERE matched_by = 'hand:2026-09-25';
  IF v_n <> 23 THEN RAISE EXCEPTION 'batch 51: % hand links, want 23', v_n; END IF;
  IF public.get_player_alias_target('dee28451-5d62-409e-a1ad-a83f763ac070', 'joseph-flacco') <> 'joe-flacco' THEN
    RAISE EXCEPTION 'batch 51: joseph-flacco does not alias to joe-flacco';
  END IF;
  IF public.get_player_alias_target('dee28451-5d62-409e-a1ad-a83f763ac070', 'kenny-gainwell') <> 'kenneth-gainwell' THEN
    RAISE EXCEPTION 'batch 51: kenny-gainwell does not alias to kenneth-gainwell';
  END IF;
  SELECT count(*) INTO v_n FROM (SELECT 1 FROM public.players GROUP BY collection_id, name HAVING count(*) > 1) z;
  IF v_n <> 0 THEN RAISE EXCEPTION 'batch 51: % duplicate (collection, name) groups', v_n; END IF;
  r := public.match_player_identities('nfl');
  RAISE NOTICE 'batch 51: match report %', r;
END $$;
