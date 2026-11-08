-- audit_20261107_ten_players_display_the_league_name
--
-- 2026-11-07 ~5:15 PM PT (Cowork cloud). Trevor, 4:59 PM, on ten players shown
-- under different names in Top Shot and Panini: "Do what is commonly accepted
-- and mapped on websites like nba.com".
--
-- THE NAMES, read from each player's OWN league page this afternoon (nba.com
-- player heading / wnba.com player heading):
--   nba.com   Jimmy Butler III · KJ Martin · GG Jackson · Ronald Holland II ·
--             Nic Claxton · Enes Freedom (stats page)
--   wnba.com  Skylar Diggins · Megan DiLeo · Maya Caldwell · Betnijah Laney-Hamilton
-- Top Shot already matched for the first five, so PANINI renames; Panini already
-- matched for the last five, so TOP SHOT renames. Every pair was already one
-- person to the /players hub (an alias joined them); only the displayed name
-- differed.
--
-- PER PLAYER (one transaction, every count asserted):
--   * players.name → the league name.
--   * the alias set keeps every old URL working: on Top Shot the existing alias
--     row already carried the NEW spelling (that is how the hub joined them), so
--     it is repointed to the OLD spelling — an UPDATE, no delete; on Panini a new
--     alias row carries the old spelling.
--   * editions.player_name, and the house label "<player> — …" (Top Shot) /
--     "<player> - …" (Panini), → the league name. The separator is part of the
--     match: "Betnijah Laney%" alone also matches "Betnijah Laney-Hamilton — …".
--   * Top Shot only: player_identities.display_name (the league's spelling) → the
--     league name, so resolve_player_name stops reporting a difference.
--
-- WHY IT STAYS: sync_panini_products_bridge, link_editions_to_players_by_name,
-- ensure_players_from_edition_names and the editions trigger
-- a_normalize_player_name_alias_* all resolve the old spelling through the alias
-- (see 20261108002428, Steph Curry). ⚠ ONE WRITER DOES NOT: upsert_player_canonical
-- (app/api/ingest) sets name = COALESCE(<Dapper's name>, name) on a Top Shot id
-- match, so if that route runs again for one of the five Top Shot players it
-- restores Dapper's spelling. It has 0 runs in pipeline_runs' retention (its
-- Top Shot GraphQL source has been dead since August); making it read aliases is
-- queued (pinned function).
--
-- anon-exec: none — no function created.
--
-- REVERT: the same loop with old/new swapped (alias rows: UPDATE back on Top Shot;
-- DELETE … WHERE note = 'audit_20261107 league name' on Panini).

DO $mig$
DECLARE
  r record;
  v_coll uuid;
  v_n int;
  v_total int := 0;
  v_old_slug text;
  v_new_slug text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('panini_blockchain', 'b2d695f2-d064-46b8-9e3f-ba155ee2eb9d'::uuid, 'Jimmy Butler',            'Jimmy Butler III',        ' - ', 58),
      ('panini_blockchain', '38aaa3b5-2e8f-4c3b-92e3-e4f740247349'::uuid, 'Kenyon Martin Jr.',       'KJ Martin',               ' - ', 17),
      ('panini_blockchain', '456e79b0-3cec-475c-9b93-a0d3eb5cf4ab'::uuid, 'GG Jackson II',           'GG Jackson',              ' - ', 12),
      ('panini_blockchain', 'a7efaad4-5c5c-478e-a23d-ecc42394f47f'::uuid, 'Ron Holland II',          'Ronald Holland II',       ' - ', 11),
      ('panini_blockchain', '0f586868-d252-49f5-9797-22cca99010ec'::uuid, 'Nicolas Claxton',         'Nic Claxton',             ' - ',  5),
      ('nba_top_shot',      '9cca9b35-d134-474a-80d7-cab2ed559d0a'::uuid, 'Skylar Diggins-Smith',    'Skylar Diggins',          ' — ',  6),
      ('nba_top_shot',      '17911378-cc7d-4d9c-be7e-340479c02d3f'::uuid, 'Megan Gustafson',         'Megan DiLeo',             ' — ',  7),
      ('nba_top_shot',      'd96477de-fcee-4eea-b8ab-7bcc2473b786'::uuid, 'Maya Caldwell-Ellwanger', 'Maya Caldwell',           ' — ',  2),
      ('nba_top_shot',      '0c08e4fe-6d3f-4b51-9618-91e0e6391bb1'::uuid, 'Betnijah Laney',          'Betnijah Laney-Hamilton', ' — ',  3),
      ('nba_top_shot',      'f2c0fd93-6f38-4a76-8105-140ba98760bd'::uuid, 'Enes Kanter',             'Enes Freedom',            ' — ',  3)
    ) v(coll, pid, old_name, new_name, sep, expect_eds)
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
    v_new_slug := regexp_replace(lower(btrim(extensions.unaccent(r.new_name))), '[^a-z0-9]+', '-', 'g');

    UPDATE public.players SET name = r.new_name, updated_at = now() WHERE id = r.pid;

    IF r.coll = 'nba_top_shot' THEN
      UPDATE public.player_name_aliases
         SET alias_slug = v_old_slug,
             note = coalesce(note || ' · ', '') || 'audit_20261107 league name (was ' || v_new_slug || ')'
       WHERE collection_id = v_coll AND player_id = r.pid AND alias_slug = v_new_slug;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RAISE EXCEPTION '% alias % expected 1 row, got %', r.coll, v_new_slug, v_n; END IF;
      UPDATE public.player_identities SET display_name = r.new_name WHERE player_id = r.pid;
    ELSE
      SELECT count(*) INTO v_n FROM public.player_name_aliases WHERE collection_id = v_coll AND alias_slug = v_old_slug;
      IF v_n <> 0 THEN RAISE EXCEPTION 'Panini alias % already present', v_old_slug; END IF;
      INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
      VALUES (v_coll, v_old_slug, r.pid, 'audit_20261107 league name');
    END IF;

    UPDATE public.editions
       SET player_name = CASE WHEN player_name = r.old_name THEN r.new_name ELSE player_name END,
           name        = CASE WHEN name LIKE r.old_name || r.sep || '%'
                              THEN r.new_name || substr(name, length(r.old_name) + 1) ELSE name END,
           updated_at  = now()
     WHERE player_id = r.pid
       AND (player_name = r.old_name OR name LIKE r.old_name || r.sep || '%');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> r.expect_eds THEN RAISE EXCEPTION '%: expected % editions, updated %', r.old_name, r.expect_eds, v_n; END IF;
    v_total := v_total + v_n;
  END LOOP;
  IF v_total <> 124 THEN RAISE EXCEPTION 'expected 124 edition rows in total, updated %', v_total; END IF;
END
$mig$;
