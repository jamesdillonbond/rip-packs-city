-- 2026-09-25 (PT) — four more NAME CHANGES the crosswalk surfaced, two of them
-- already duplicated in the Top Shot catalog. The third stats tick left 57
-- names unkeyed; read one by one on ESPN's search: Enes Kanter is "Enes
-- Freedom" (2021), Skylar Diggins-Smith is "Skylar Diggins" (2024), Betnijah
-- Laney is "Betnijah Laney-Hamilton" (2024), Megan Gustafson is "Megan DiLeo"
-- — and Top Shot itself had relabelled newer moments, so the catalog held
-- "Skylar Diggins" (4 editions, slug-minted) beside "Skylar Diggins-Smith"
-- (10, NBA id 203400) and "Betnijah Laney-Hamilton" (3, flow:5599) beside
-- "Betnijah Laney" (5, NBA id 204335): one person, two pages, two rows the
-- concierge could not connect.
--
-- Per the recorded decision (batch 55: no renames, aliases carry the other
-- spelling): the two label-minted duplicates merge INTO the keyed rows
-- (backups in the batch-44 audit tables), the four current names become
-- aliases (their URLs 308, the name writers stop re-minting them, the stats
-- runner's alias retry finds the ESPN entry), and player_relations records
-- each change so the concierge names both. Every 'unresolved:*' NBA identity
-- is re-queued once for the runner's new stats probe (batch 60).
--
-- Revert: players/editions from audit_20260925_suffix_players_backup /
-- audit_20260925_suffix_editions_backup (rows stamped now()); DELETE FROM
-- player_name_aliases WHERE note LIKE 'batch 60%'; DELETE FROM
-- player_relations WHERE note LIKE '%(batch 60)%'.

DO $$
DECLARE
  r RECORD; v_keep uuid; v_drop uuid; v_moved int;
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_slug text;
BEGIN
  -- (1) the two duplicates: current-name row → the keyed row
  FOR r IN SELECT * FROM (VALUES
      ('Skylar Diggins',          'Skylar Diggins-Smith'),
      ('Betnijah Laney-Hamilton', 'Betnijah Laney')
    ) v(drop_name, keep_name)
  LOOP
    SELECT id INTO v_keep FROM public.players WHERE collection_id = v_ts AND name = r.keep_name;
    SELECT id INTO v_drop FROM public.players WHERE collection_id = v_ts AND name = r.drop_name;
    IF v_keep IS NULL THEN RAISE EXCEPTION 'batch 60: keep row "%" not found', r.keep_name; END IF;
    IF v_drop IS NULL THEN RAISE NOTICE 'batch 60: "%" already gone', r.drop_name; CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = v_keep) THEN
      RAISE EXCEPTION 'batch 60: keep row "%" is not the crosswalk-keyed row', r.keep_name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = v_drop) THEN
      RAISE EXCEPTION 'batch 60: drop row "%" carries an identity', r.drop_name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect WHERE player_id = v_drop)
       OR EXISTS (SELECT 1 FROM public.panini_bridge_candidate_editions WHERE player_id = v_drop)
       OR EXISTS (SELECT 1 FROM public.badge_editions WHERE player_id = v_drop::text) THEN
      RAISE EXCEPTION 'batch 60: "%" is referenced outside editions', r.drop_name;
    END IF;
    INSERT INTO public.audit_20260925_suffix_players_backup SELECT p.*, now() FROM public.players p WHERE p.id = v_drop;
    INSERT INTO public.audit_20260925_suffix_editions_backup (edition_id, player_id)
      SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id = v_drop
      ON CONFLICT (edition_id) DO NOTHING;
    UPDATE public.editions SET player_id = v_keep WHERE player_id = v_drop;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    UPDATE public.player_name_aliases SET player_id = v_keep WHERE player_id = v_drop;
    DELETE FROM public.players WHERE id = v_drop;
    RAISE NOTICE 'batch 60: merged "%" into "%": % editions', r.drop_name, r.keep_name, v_moved;
  END LOOP;

  -- (2) the current names as aliases + the recorded change
  FOR r IN SELECT * FROM (VALUES
      ('Enes Kanter',          'Enes Freedom',            'Changed his name to Enes Freedom in 2021; Top Shot moments are labelled Enes Kanter (batch 60)'),
      ('Skylar Diggins-Smith', 'Skylar Diggins',          'Goes by Skylar Diggins since 2024; older Top Shot moments are labelled Skylar Diggins-Smith, newer ones Skylar Diggins — one person (batch 60)'),
      ('Betnijah Laney',       'Betnijah Laney-Hamilton', 'Betnijah Laney-Hamilton since 2024; older Top Shot moments are labelled Betnijah Laney, newer ones Laney-Hamilton — one person (batch 60)'),
      ('Megan Gustafson',      'Megan DiLeo',             'ESPN lists her as Megan DiLeo (married name); Top Shot moments are labelled Megan Gustafson (batch 60)')
    ) v(row_name, other_name, note)
  LOOP
    SELECT id INTO v_keep FROM public.players WHERE collection_id = v_ts AND name = r.row_name;
    IF v_keep IS NULL THEN RAISE EXCEPTION 'batch 60: "%" not found', r.row_name; END IF;
    v_slug := regexp_replace(lower(trim(extensions.unaccent(r.other_name))), '[^a-z0-9]+', '-', 'g');
    IF EXISTS (SELECT 1 FROM public.players p WHERE p.collection_id = v_ts
                 AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug) THEN
      RAISE EXCEPTION 'batch 60: a row still owns the slug %', v_slug;
    END IF;
    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
      VALUES (v_ts, v_slug, v_keep, 'batch 60 2026-09-25: current name of ' || r.row_name)
      ON CONFLICT (collection_id, alias_slug) DO NOTHING;
    INSERT INTO public.player_relations (collection_id, player_id, relation, name, note)
      VALUES (v_ts, v_keep, 'name_change', r.other_name, r.note)
      ON CONFLICT DO NOTHING;
  END LOOP;

  -- (3) re-queue every unsettled NBA name for the runner's stats probe
  UPDATE public.player_identities SET espn_id_matched_by = NULL
   WHERE league = 'nba' AND espn_id IS NULL AND espn_id_matched_by LIKE 'unresolved:%';
END $$;

-- Post-conditions
DO $$
DECLARE v_n int; r jsonb;
BEGIN
  SELECT count(*) INTO v_n FROM public.players WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND name IN ('Skylar Diggins', 'Betnijah Laney-Hamilton');
  IF v_n <> 0 THEN RAISE EXCEPTION 'batch 60: % duplicate rows remain', v_n; END IF;
  IF public.get_player_alias_target('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'enes-freedom') <> 'enes-kanter' THEN
    RAISE EXCEPTION 'batch 60: enes-freedom does not alias to enes-kanter'; END IF;
  r := public.resolve_player_name('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Skylar Diggins');
  IF r->>'status' <> 'one' OR r->'player'->>'name' <> 'Skylar Diggins-Smith' OR r->>'matched_via' <> 'alias'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'relations') x WHERE x->>'relation' = 'also_known_as' AND x->>'name' = 'Skylar Diggins') THEN
    RAISE EXCEPTION 'batch 60: Skylar Diggins -> %', r; END IF;
  IF (r->'player'->>'edition_count')::int < 14 THEN RAISE EXCEPTION 'batch 60: Diggins-Smith holds % editions, want 14', r->'player'->>'edition_count'; END IF;
  SELECT count(*) INTO v_n FROM public.player_identities WHERE league = 'nba' AND espn_id IS NULL AND espn_id_matched_by LIKE 'unresolved:%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'batch 60: % still marked unresolved', v_n; END IF;
END $$;
