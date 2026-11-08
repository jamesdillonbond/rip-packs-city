-- audit_20261107_panini_surtain_and_marvin_jones_follow_nfl_name
--
-- 2026-11-07 ~9:30 PM PT (Claude Code cloud). Follows 20261108052909: All Day now
-- names these two by nfl.com ("Pat Surtain II", "Marvin Jones" — the WR), so the
-- Panini rows for the same people take the same name (20 and 6 editions; the
-- Panini cards are the Broncos CB and the veteran WR). Old spellings kept as
-- Panini aliases. Integrity watch 0/0/0.
--
-- anon-exec: none — no function created.
--
-- REVERT: swap names back; DELETE FROM player_name_aliases WHERE collection_id = Panini AND note = 'audit_20261107 nfl.com name' AND alias_slug IN ('patrick-surtain-ii','marvin-jones-jr-');

DO $mig$
DECLARE
  r record;
  v_n int;
  c_p constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('bff5771a-7147-47ab-9f75-1afa6647f18f'::uuid, 'Patrick Surtain II', 'Pat Surtain II', 20),
      ('d22b12b4-ddc6-4101-a5f1-71e57631207f'::uuid, 'Marvin Jones Jr.',   'Marvin Jones',    6)
    ) v(pid, old_name, new_name, expect_eds)
  LOOP
    PERFORM 1 FROM public.players WHERE id = r.pid AND name = r.old_name AND collection_id = c_p;
    IF NOT FOUND THEN RAISE EXCEPTION '% changed; re-read', r.old_name; END IF;
    SELECT count(*) INTO v_n FROM public.players WHERE collection_id = c_p AND id <> r.pid AND lower(name) = lower(r.new_name);
    IF v_n <> 0 THEN RAISE EXCEPTION '% already exists on Panini', r.new_name; END IF;
    UPDATE public.players SET name = r.new_name, updated_at = now() WHERE id = r.pid;
    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
    VALUES (c_p, regexp_replace(lower(btrim(r.old_name)), '[^a-z0-9]+', '-', 'g'), r.pid, 'audit_20261107 nfl.com name');
    UPDATE public.editions
       SET player_name = CASE WHEN player_name = r.old_name THEN r.new_name ELSE player_name END,
           name = CASE WHEN name LIKE r.old_name || ' - %' THEN r.new_name || substr(name, length(r.old_name) + 1) ELSE name END,
           updated_at = now()
     WHERE player_id = r.pid AND (player_name = r.old_name OR name LIKE r.old_name || ' - %');
    GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> r.expect_eds THEN RAISE EXCEPTION '%: % editions, want %', r.old_name, v_n, r.expect_eds; END IF;
  END LOOP;
END
$mig$;
