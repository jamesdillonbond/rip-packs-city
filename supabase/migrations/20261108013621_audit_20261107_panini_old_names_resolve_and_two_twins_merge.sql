-- audit_20261107_panini_old_names_resolve_and_two_twins_merge
--
-- 2026-11-07 ~5:45 PM PT (Cowork cloud). Trevor, 5:33 PM: "The search bar and
-- concierge need to be aware of all of this though and can help users either
-- way." Follow-up to 20261108002428 (Steph Curry) and 20261108010337 (ten
-- players take the league name).
--
-- WHAT A PROBE FOUND. Every old AND new spelling was run through
-- rpc_search_catalog. Panini held a SECOND row for two of the people under the
-- old name — "Skylar Diggins-Smith" (11 cards) beside "Skylar Diggins" (20),
-- "Enes Kanter" (4) beside "Enes Freedom" (1) — so the old name answered with a
-- separate player instead of the person. And Panini had no alias for the old
-- WNBA spellings, so neither search nor resolve_player_name could map
-- "Maya Caldwell-Ellwanger" / "Betnijah Laney" to the Panini row.
--
-- CHANGE (one transaction, counts asserted). The 2026-10-04 merge pattern
-- (docs/reference/player-identity.md, D26): for each twin — register the twin's
-- name as an alias of the canonical row FIRST (so the bridge and the editions
-- trigger resolve it from now on), repoint the twin's editions and rewrite their
-- labels "<twin> - …" → "<canonical> - …", then remove the empty twin (no
-- relations, identities or aliases reference either; checked). Plus two plain
-- aliases: maya-caldwell-ellwanger, betnijah-laney. megan-gustafson already
-- existed (20261004190200).
--
-- anon-exec: none — no function created.
--
-- REVERT: re-create the twin rows (external_ids panini-skylar-diggins-smith,
-- panini-enes-kanter) and repoint editions WHERE note LIKE …; the bridge would
-- re-mint them on its next tick if the four alias rows
-- (note = 'audit_20261107 panini old name') are deleted.

DO $mig$
DECLARE
  v_coll uuid;
  r record;
  v_n int;
BEGIN
  SELECT id INTO v_coll FROM public.collections WHERE slug = 'panini_blockchain';

  FOR r IN SELECT * FROM (VALUES
      ('ae584dbb-fc42-4f38-99bd-8541aa520665'::uuid, 'Skylar Diggins-Smith', '2f410edf-4278-49a3-999f-91a6db5d8a8b'::uuid, 'Skylar Diggins', 11),
      ('d9f44559-e4f7-4692-8829-c67bf2fae39d'::uuid, 'Enes Kanter',          'b4e32fa4-16cc-4710-ac06-4e960d75e8f8'::uuid, 'Enes Freedom',   4)
    ) v(twin, twin_name, canon, canon_name, expect_eds)
  LOOP
    PERFORM 1 FROM public.players WHERE id = r.twin AND name = r.twin_name AND collection_id = v_coll;
    IF NOT FOUND THEN RAISE EXCEPTION 'twin % moved', r.twin_name; END IF;
    PERFORM 1 FROM public.players WHERE id = r.canon AND name = r.canon_name AND collection_id = v_coll;
    IF NOT FOUND THEN RAISE EXCEPTION 'canonical % moved', r.canon_name; END IF;
    IF EXISTS (SELECT 1 FROM public.player_relations WHERE player_id = r.twin OR related_player_id = r.twin)
       OR EXISTS (SELECT 1 FROM public.player_identities WHERE player_id = r.twin)
       OR EXISTS (SELECT 1 FROM public.player_name_aliases WHERE player_id = r.twin) THEN
      RAISE EXCEPTION 'twin % gained a reference; re-read before merging', r.twin_name;
    END IF;

    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
    VALUES (v_coll, regexp_replace(lower(btrim(extensions.unaccent(r.twin_name))), '[^a-z0-9]+', '-', 'g'), r.canon, 'audit_20261107 panini old name');

    UPDATE public.editions
       SET player_id   = r.canon,
           player_name = CASE WHEN player_name = r.twin_name THEN r.canon_name ELSE player_name END,
           name        = CASE WHEN name LIKE r.twin_name || ' - %' THEN r.canon_name || substr(name, length(r.twin_name) + 1) ELSE name END,
           updated_at  = now()
     WHERE player_id = r.twin;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> r.expect_eds THEN RAISE EXCEPTION '%: expected % editions, moved %', r.twin_name, r.expect_eds, v_n; END IF;

    DELETE FROM public.players WHERE id = r.twin;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'twin % delete affected %', r.twin_name, v_n; END IF;
  END LOOP;

  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
  SELECT v_coll, x.slug, x.pid, 'audit_20261107 panini old name'
    FROM (VALUES ('maya-caldwell-ellwanger', 'ffff4b4c-4c33-44ad-b8df-c73cf7126411'::uuid),
                 ('betnijah-laney',          '9a584883-6120-4050-8b30-d5c02aef00ab'::uuid)) x(slug, pid)
   WHERE NOT EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.collection_id = v_coll AND a.alias_slug = x.slug);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected 2 plain aliases, inserted %', v_n; END IF;
END
$mig$;
