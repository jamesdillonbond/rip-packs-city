-- 2026-09-25 (PT) — #139 follow-up: the two renames in 20260925… (suffix-variant
-- players) landed on names that ALREADY had a row — "KJ Martin" (Top Shot, the
-- per-play fossil flow:6020, 1 edition) and "Byron Murphy II" (All Day,
-- nfl_all_day-byron-murphy-ii, 2 editions) — so each name briefly had two rows.
-- The pre-check grouped on the suffix-stripped name and could not see "KJ" as a
-- variant of "Kenyon … Jr."; the Byron Murphy triple was handled as one rename.
-- Merge each pair into the row keyed by the league / canonical id, carry the
-- alias across, back up the dropped rows in the same audit tables.
-- Revert: INSERT the rows back from audit_20260925_suffix_players_backup and
-- repoint from audit_20260925_suffix_editions_backup (the same tables).

DO $$
DECLARE
  r RECORD;
  v_keep uuid; v_drop uuid; v_moved int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'KJ Martin',       '1630231',                    'flow:6020'),
      ('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'Byron Murphy II', 'nfl_all_day-byron-murphy-ii', 'nfl_all_day-byron-murphy')
    ) v(collection_id, name, keep_ext, drop_ext)
  LOOP
    SELECT id INTO v_keep FROM public.players WHERE collection_id = r.collection_id AND name = r.name AND external_id = r.keep_ext;
    SELECT id INTO v_drop FROM public.players WHERE collection_id = r.collection_id AND name = r.name AND external_id = r.drop_ext;
    IF v_keep IS NULL THEN RAISE EXCEPTION '#139: keep row % (%) not found', r.name, r.keep_ext; END IF;
    IF v_drop IS NULL THEN RAISE NOTICE '#139: % (%) already gone', r.name, r.drop_ext; CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect WHERE player_id = v_drop)
       OR EXISTS (SELECT 1 FROM public.panini_bridge_candidate_editions WHERE player_id = v_drop)
       OR EXISTS (SELECT 1 FROM public.badge_editions WHERE player_id = v_drop::text) THEN
      RAISE EXCEPTION '#139: % (%) is referenced outside editions', r.name, r.drop_ext;
    END IF;
    INSERT INTO public.audit_20260925_suffix_players_backup SELECT p.*, now() FROM public.players p WHERE p.id = v_drop;
    INSERT INTO public.audit_20260925_suffix_editions_backup (edition_id, player_id)
      SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id = v_drop
      ON CONFLICT (edition_id) DO NOTHING;
    UPDATE public.editions SET player_id = v_keep WHERE player_id = v_drop;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    -- the alias registered on the dropped row ('kenyon-martin-jr-' / 'byron-murphy') follows the person
    UPDATE public.player_name_aliases SET player_id = v_keep WHERE player_id = v_drop;
    DELETE FROM public.players WHERE id = v_drop;
    RAISE NOTICE '#139: merged % (%) into (%): % editions', r.name, r.drop_ext, r.keep_ext, v_moved;
  END LOOP;
END $$;

-- Post-condition: no two players rows share a (collection, name) anywhere, and
-- the two aliases now point at the kept rows.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM (SELECT 1 FROM public.players GROUP BY collection_id, name HAVING count(*) > 1) z;
  IF v_n <> 0 THEN RAISE EXCEPTION '#139: % duplicate (collection, name) groups remain', v_n; END IF;
  IF public.get_player_alias_target('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'kenyon-martin-jr-') <> 'kj-martin' THEN
    RAISE EXCEPTION '#139: kenyon-martin-jr- does not alias to kj-martin';
  END IF;
  IF public.get_player_alias_target('dee28451-5d62-409e-a1ad-a83f763ac070', 'byron-murphy') <> 'byron-murphy-ii' THEN
    RAISE EXCEPTION '#139: byron-murphy does not alias to byron-murphy-ii';
  END IF;
END $$;
