-- audit_20261107_panini_stephen_curry_displays_as_steph_curry
--
-- 2026-11-07 ~4:30 PM PT (Cowork cloud). Trevor, 4:21 PM: "Steph and Stephen
-- Curry are the same person. I'd just consolidate and display it as Steph."
--
-- WHAT WAS WRONG. Search, the /players hub and the Panini player page showed one
-- person under two names: Top Shot's player row is "Steph Curry" (alias
-- stephen-curry → it, since 09-25), Panini's is "Stephen Curry" (199 editions,
-- external_id panini-stephen-curry, no alias). /players/steph-curry and
-- /players/stephen-curry both answered 200 headlined "Stephen Curry".
--
-- CHANGE (data only, one transaction):
--   1. players 41db772b… (Panini) name → "Steph Curry".
--   2. player_name_aliases (Panini, 'stephen-curry') → that row, so the old
--      /panini-blockchain/player/stephen-curry 308s, and the bridge resolves
--      Panini's source label "Stephen Curry" through the alias (no collision
--      flag, no re-minted row — sync_panini_products_bridge reads aliases since
--      20261004190100).
--   3. the 199 linked editions: player_name and the house label "<player> - …"
--      → "Steph Curry". This is the same value the editions trigger
--      a_normalize_player_name_alias_* stores on every later write, and the one
--      the bridge's drift check compares against (20261021065738), so the bridge
--      does not churn them back.
-- The three multi-player Panini rows ("Stephen Curry | …") are card identities,
-- not the person, and are left as they are.
--
-- anon-exec: none — no function created.
--
-- REVERT: UPDATE public.players SET name = 'Stephen Curry' WHERE id = '41db772b-5518-4c7b-b400-1544616fc5d8';
--         DELETE FROM public.player_name_aliases WHERE note = 'audit_20261107 steph curry consolidation';
--         UPDATE public.editions SET player_name = 'Stephen Curry', name = 'Stephen Curry' || substr(name, length('Steph Curry') + 1)
--          WHERE player_id = '41db772b-5518-4c7b-b400-1544616fc5d8' AND name LIKE 'Steph Curry%';

DO $mig$
DECLARE
  c_pid constant uuid := '41db772b-5518-4c7b-b400-1544616fc5d8';
  v_coll uuid;
  v_n int;
BEGIN
  SELECT p.collection_id INTO v_coll FROM public.players p
   JOIN public.collections c ON c.id = p.collection_id AND c.slug = 'panini_blockchain'
   WHERE p.id = c_pid AND p.name = 'Stephen Curry';
  IF v_coll IS NULL THEN RAISE EXCEPTION 'Panini Stephen Curry row moved or renamed; re-read before applying'; END IF;

  SELECT count(*) INTO v_n FROM public.players
   WHERE collection_id = v_coll AND lower(extensions.unaccent(name)) = 'steph curry';
  IF v_n <> 0 THEN RAISE EXCEPTION 'a Panini "Steph Curry" row already exists (%); merge instead', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.player_name_aliases
   WHERE collection_id = v_coll AND alias_slug IN ('stephen-curry', 'steph-curry');
  IF v_n <> 0 THEN RAISE EXCEPTION 'Panini alias already present (%)', v_n; END IF;

  UPDATE public.players SET name = 'Steph Curry', updated_at = now() WHERE id = c_pid;

  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
  VALUES (v_coll, 'stephen-curry', c_pid, 'audit_20261107 steph curry consolidation');

  UPDATE public.editions
     SET player_name = 'Steph Curry',
         name        = 'Steph Curry' || substr(name, length('Stephen Curry') + 1),
         updated_at  = now()
   WHERE player_id = c_pid AND player_name = 'Stephen Curry' AND name LIKE 'Stephen Curry%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 199 THEN RAISE EXCEPTION 'expected 199 editions, updated %', v_n; END IF;
END
$mig$;
