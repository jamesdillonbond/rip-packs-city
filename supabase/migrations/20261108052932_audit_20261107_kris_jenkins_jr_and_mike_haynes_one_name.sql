-- audit_20261107_kris_jenkins_jr_and_mike_haynes_one_name
--
-- 2026-11-07 ~9:30 PM PT (Claude Code cloud). The two cases left open by
-- 20261108050840, settled:
--   * Kris Jenkins Jr. — Panini's 2024 Rookies Prizm cards are the Bengals DT
--     (son), "Kris Jenkins" on Panini, "Kris Jenkins Jr." on All Day. nfl.com heads
--     both him and his father "Kris Jenkins", so here the suffix is what keeps two
--     people apart (runbook rule): Panini takes "Kris Jenkins Jr.".
--   * Mike Haynes — All Day's "Mike Haynes Jr." Raiders Vintage card (Super Bowl
--     XVIII) is the Hall of Fame cornerback, whose crosswalk row (nflverse,
--     CB 1976–89) and Pro Football Hall of Fame / Raiders pages say "Mike Haynes";
--     Panini already does. All Day takes "Mike Haynes".
-- Old spellings kept as aliases in their own collection. Integrity watch 0/0/0.
--
-- anon-exec: none — no function created.
--
-- REVERT: swap names back; DELETE FROM player_name_aliases WHERE note = 'audit_20261107 one name across collections';

DO $mig$
DECLARE
  r record;
  v_n int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- Panini's 2024 Rookies Prizm cards are the Bengals DT (son); All Day calls him "Kris Jenkins Jr.".
      -- nfl.com heads BOTH him and his father "Kris Jenkins", so the suffix stays: it is what keeps two people apart.
      ('panini_blockchain', 'ac06454f-fcdb-4ac8-92dd-b8457720be7c'::uuid, 'Kris Jenkins',    'Kris Jenkins Jr.', ' - ', 4),
      -- All Day's Raiders Vintage card (Super Bowl XVIII, 1984) is the Hall of Famer, whose identity row (nflverse
      -- HAY692125, CB 1976–89) and Hall of Fame / Raiders pages all say "Mike Haynes" — no "Jr."; Panini says the same.
      ('nfl_all_day',       '7e683fd9-ded6-4293-862e-fc97c3a95fda'::uuid, 'Mike Haynes Jr.', 'Mike Haynes',      ' — ', 1)
    ) v(coll, pid, old_name, new_name, sep, expect_eds)
  LOOP
    PERFORM 1 FROM public.players p JOIN public.collections c ON c.id = p.collection_id AND c.slug = r.coll
     WHERE p.id = r.pid AND p.name = r.old_name;
    IF NOT FOUND THEN RAISE EXCEPTION '% changed; re-read', r.old_name; END IF;
    SELECT count(*) INTO v_n FROM public.players p WHERE p.collection_id = (SELECT collection_id FROM public.players WHERE id = r.pid)
       AND p.id <> r.pid AND lower(p.name) = lower(r.new_name);
    IF v_n <> 0 THEN RAISE EXCEPTION '% already exists in %', r.new_name, r.coll; END IF;
    UPDATE public.players SET name = r.new_name, updated_at = now() WHERE id = r.pid;
    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
    SELECT collection_id, regexp_replace(lower(btrim(r.old_name)), '[^a-z0-9]+', '-', 'g'), id, 'audit_20261107 one name across collections'
      FROM public.players WHERE id = r.pid;
    UPDATE public.player_identities SET display_name = r.new_name WHERE player_id = r.pid AND r.coll <> 'nfl_all_day';
    UPDATE public.editions
       SET player_name = CASE WHEN player_name = r.old_name THEN r.new_name ELSE player_name END,
           name = CASE WHEN name LIKE r.old_name || r.sep || '%' THEN r.new_name || substr(name, length(r.old_name) + 1) ELSE name END,
           updated_at = now()
     WHERE player_id = r.pid AND (player_name = r.old_name OR name LIKE r.old_name || r.sep || '%');
    GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> r.expect_eds THEN RAISE EXCEPTION '%: % editions, want %', r.old_name, v_n, r.expect_eds; END IF;
  END LOOP;
END
$mig$;
