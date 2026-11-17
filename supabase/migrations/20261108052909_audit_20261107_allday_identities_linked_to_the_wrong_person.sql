-- audit_20261107_allday_identities_linked_to_the_wrong_person
--
-- 2026-11-07 ~9:30 PM PT (Claude Code cloud; Trevor: "Keep going").
--
-- WHAT WAS WRONG. player_identities (the nflverse crosswalk behind player pages'
-- league facts, headshots, stats and the concierge's identity block) had five
-- All Day players linked to the WRONG person. Found by comparing each linked
-- identity's rookie..last season with the game years of the player's editions:
--   * "Patrick Surtain II" (3 editions, Broncos 2021) — linked by the suffix arm
--     to his FATHER (Patrick Surtain, CB 1998–2008) — and it was itself a twin of
--     "Pat Surtain II" (11 editions, already correctly linked). Merged.
--   * "Ed Jones" (Cowboys Vintage, 1982–83) → was the 1975 Bills safety; is Ed
--     "Too Tall" Jones (DE, DAL 1974–89). "too-tall-jones" added as an alias.
--   * "Leonard Taylor" (Patriots 2026) → was a 2023 Jaguars TE; is Leonard Taylor
--     III (DT, NE 2024–).
--   * "Oronde Gadsden" (Chargers 2025 rookie) → was his father (WR 1995–2003); is
--     Oronde Gadsden II.
--   * "Marvin Jones Jr." (Jaguars 2021–22) → was a 2026 rookie linebacker; is
--     Marvin Jones (WR 2012–23).
-- The remaining season mismatches are Top Shot legends whose NBA rows carry
-- late-career seasons only (Bill Walton, Pete Maravich…) and Franco Harris'
-- pre-1974 games — same person, coverage quirks, left alone.
--
-- NAMES. nfl.com headings read 11-07: "Pat Surtain II", "Leonard Taylor III",
-- "Oronde Gadsden II", "Marvin Jones" (the WR; "Marvin Jones Jr." is the rookie
-- LB) — All Day rows renamed, old labels kept as aliases.
-- ⚠ When the rookie LB Marvin Jones Jr. gets an All Day card, the
-- "marvin-jones-jr-" alias would place it on the WR: split it then.
--
-- VERIFIED AT APPLY: resolve_player_name maps "Patrick Surtain II", "Too Tall
-- Jones", "Oronde Gadsden", "Marvin Jones Jr.", "Leonard Taylor" to the right
-- person with rookie seasons 2021 / 1974 / 2025 / 2012 / 2024;
-- check_player_alias_integrity() 0/0/0.
--
-- anon-exec: none — no function created.
--
-- REVERT: re-link the old identity ids (in the VALUES below) and swap names back;
-- DELETE the aliases this adds (notes 'audit_20261107 twin merged…',
-- '…nfl.com name (identity fix)', '…the name he is known by'). The Surtain twin
-- row is gone; re-create only if a source re-emits that label.

DO $mig$
DECLARE
  c_ad constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_n int;
  r record;
BEGIN
  -- 1. "Patrick Surtain II" (3 editions, 2021) is a TWIN of "Pat Surtain II" (11
  --    editions, 2022–26) — and the suffix arm had linked the twin to his FATHER's
  --    identity (Patrick Surtain, CB 1998–2008, KC). Merge into Pat Surtain II.
  PERFORM 1 FROM public.players WHERE id = 'd97d3ada-8530-455d-9766-a84e4963007c' AND name = 'Patrick Surtain II' AND collection_id = c_ad;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patrick Surtain II twin changed; re-read'; END IF;
  PERFORM 1 FROM public.players WHERE id = '54a873ad-f905-4d0a-8169-29c594ae2be0' AND name = 'Pat Surtain II' AND collection_id = c_ad;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pat Surtain II changed; re-read'; END IF;
  UPDATE public.player_identities SET player_id = NULL, matched_by = NULL, matched_at = NULL
   WHERE id = '97886ecf-d2ed-49c7-84af-8bd61ea9245a' AND player_id = 'd97d3ada-8530-455d-9766-a84e4963007c';
  GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> 1 THEN RAISE EXCEPTION 'father identity unlink: % rows', v_n; END IF;
  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
  VALUES (c_ad, 'patrick-surtain-ii', '54a873ad-f905-4d0a-8169-29c594ae2be0', 'audit_20261107 twin merged (was linked to his father)');
  UPDATE public.editions
     SET player_id = '54a873ad-f905-4d0a-8169-29c594ae2be0',
         player_name = 'Pat Surtain II',
         name = CASE WHEN name LIKE 'Patrick Surtain II — %' THEN 'Pat Surtain II' || substr(name, length('Patrick Surtain II') + 1) ELSE name END,
         updated_at = now()
   WHERE player_id = 'd97d3ada-8530-455d-9766-a84e4963007c';
  GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> 3 THEN RAISE EXCEPTION 'Surtain repoint: % rows, want 3', v_n; END IF;
  DELETE FROM public.players WHERE id = 'd97d3ada-8530-455d-9766-a84e4963007c';
  GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> 1 THEN RAISE EXCEPTION 'Surtain twin delete: % rows', v_n; END IF;

  -- 2. Identities linked to the WRONG person by name (editions' game years and
  --    teams disagree with the league row). Unlink the wrong one, link the right
  --    one by hand.
  FOR r IN
    SELECT * FROM (VALUES
      -- All Day "Ed Jones": Cowboys Vintage, 1982–83 = Ed "Too Tall" Jones (DE, DAL 1974–89), not the 1975 BUF safety
      ('b9c80333-4dee-4ebb-a6a8-b115acf2f208'::uuid, '89904ab5-32bd-4b5b-b87e-8a78df344357'::uuid, '1e222f33-c9cb-4472-8af7-19cb7c245619'::uuid),
      -- "Leonard Taylor": Patriots 2026 = Leonard Taylor III (DT, NE 2024–), not the 2023 JAX tight end
      ('1026bec7-827a-41b2-b7d5-cedfad0add3a'::uuid, 'aef4a59e-f417-4287-bf5b-12c26b48c1ca'::uuid, 'e762d23d-5f48-4c55-bfbf-8ece83ca369f'::uuid),
      -- "Oronde Gadsden": Chargers 2025 rookie = Oronde Gadsden II (TE, LAC 2025–), not his father (WR, MIA 1995–2003)
      ('5b9325bc-daa1-4005-b5d7-bee0d43fcc4b'::uuid, '709eb58c-7fe3-481b-b3e0-291a9c78413f'::uuid, '1e543d58-d09f-424f-a91e-1bd788cd0d8b'::uuid),
      -- "Marvin Jones Jr.": Jaguars 2021–22 = Marvin Jones (WR, 2012–23), not the 2026 rookie linebacker
      ('04ccb36d-e36d-4d31-98e1-2a38c46b5dcb'::uuid, '11d35033-3ef3-419e-b60a-c4c7800ee083'::uuid, '19311063-4240-41b9-97e8-bdd23f06d2d4'::uuid)
    ) v(pid, wrong_id, right_id)
  LOOP
    UPDATE public.player_identities SET player_id = NULL, matched_by = NULL, matched_at = NULL
     WHERE id = r.wrong_id AND player_id = r.pid;
    GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> 1 THEN RAISE EXCEPTION 'unlink % from %: % rows', r.wrong_id, r.pid, v_n; END IF;
    UPDATE public.player_identities
       SET player_id = r.pid, collection_id = c_ad, matched_by = 'hand:2026-11-07', matched_at = now(),
           stats_refreshed_at = NULL
     WHERE id = r.right_id AND player_id IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> 1 THEN RAISE EXCEPTION 'link % to %: % rows', r.right_id, r.pid, v_n; END IF;
  END LOOP;

  -- 3. The nfl.com names (page headings read 11-07) for the three whose All Day
  --    label differs; the old label stays as an alias. "Ed Jones" keeps All Day's
  --    label and gains "too-tall-jones" as an alias, so either name finds him.
  FOR r IN
    SELECT * FROM (VALUES
      ('1026bec7-827a-41b2-b7d5-cedfad0add3a'::uuid, 'Leonard Taylor',   'Leonard Taylor III', 3),
      ('5b9325bc-daa1-4005-b5d7-bee0d43fcc4b'::uuid, 'Oronde Gadsden',   'Oronde Gadsden II',  3),
      ('04ccb36d-e36d-4d31-98e1-2a38c46b5dcb'::uuid, 'Marvin Jones Jr.', 'Marvin Jones',       2)
    ) v(pid, old_name, new_name, expect_eds)
  LOOP
    PERFORM 1 FROM public.players WHERE id = r.pid AND name = r.old_name AND collection_id = c_ad;
    IF NOT FOUND THEN RAISE EXCEPTION '% changed; re-read', r.old_name; END IF;
    SELECT count(*) INTO v_n FROM public.players WHERE collection_id = c_ad AND id <> r.pid AND lower(name) = lower(r.new_name);
    IF v_n <> 0 THEN RAISE EXCEPTION '% already exists on All Day', r.new_name; END IF;
    UPDATE public.players SET name = r.new_name, updated_at = now() WHERE id = r.pid;
    INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
    VALUES (c_ad, regexp_replace(lower(btrim(r.old_name)), '[^a-z0-9]+', '-', 'g'), r.pid, 'audit_20261107 nfl.com name (identity fix)');
    UPDATE public.editions
       SET player_name = CASE WHEN player_name = r.old_name THEN r.new_name ELSE player_name END,
           name = CASE WHEN name LIKE r.old_name || ' — %' THEN r.new_name || substr(name, length(r.old_name) + 1) ELSE name END,
           updated_at = now()
     WHERE player_id = r.pid AND (player_name = r.old_name OR name LIKE r.old_name || ' — %');
    GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> r.expect_eds THEN RAISE EXCEPTION '%: % editions, want %', r.old_name, v_n, r.expect_eds; END IF;
  END LOOP;
  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
  VALUES (c_ad, 'too-tall-jones', 'b9c80333-4dee-4ebb-a6a8-b115acf2f208', 'audit_20261107 the name he is known by');
END
$mig$;
