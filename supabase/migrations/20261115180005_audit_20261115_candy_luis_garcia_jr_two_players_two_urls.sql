-- 2026-11-15 (PT) — deep audit R153 follow-on; Trevor: "Yes fix all of this" (the rename was his call:
-- the 09-25 identity decision is "alias, never rename", and this is the case it cannot cover).
-- Candy has TWO players on ONE slug: "Luis Garcia" (Houston Astros pitcher, 9 editions, row 4ede4af0…)
-- and "Luis García" (Washington Nationals infielder, 3 editions, row 462c23be…). Both unaccent to
-- `luis-garcia`, and get_player_editions resolves a slug with LIMIT 1, so one of the two had no
-- reachable player page. An alias cannot separate them (it maps a spelling to ONE row).
-- Change: the Nationals row takes MLB.com's own spelling, "Luis García Jr." (slug luis-garcia-jr);
-- the Astros row keeps luis-garcia. Edition labels (editions.player_name) are unchanged, and both
-- linkers (link_editions_to_players_by_name, candy_link_catalog) only touch player_id IS NULL, so the
-- 12 linked editions stay where they are.
-- ⚠ Residual: a FUTURE Candy edition labelled "Luis García" (Nationals) would name-match the Astros row
-- in link_editions_to_players_by_name (one accent-folded name match). Recorded in known-issues #258.
-- Revert: UPDATE public.players SET name = 'Luis García' WHERE id = '462c23be-48d9-4685-a01f-0b9e80510ba7';
DO $$
DECLARE v_n int;
BEGIN
  UPDATE public.players SET name = 'Luis García Jr.'
   WHERE id = '462c23be-48d9-4685-a01f-0b9e80510ba7' AND name = 'Luis García'
     AND collection_id = '209ade70-32c5-4470-bc7c-4793d660f713';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'Luis García row not in the expected state (updated %)', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.editions e WHERE e.player_id = '462c23be-48d9-4685-a01f-0b9e80510ba7'
              AND e.team_name IS DISTINCT FROM 'Washington Nationals') THEN
    RAISE EXCEPTION 'the renamed row holds a non-Nationals edition';
  END IF;
  SELECT count(*) INTO v_n FROM public.players
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
     AND regexp_replace(lower(trim(extensions.unaccent(name))), '[^a-z0-9]+', '-', 'g') = 'luis-garcia';
  IF v_n <> 1 THEN RAISE EXCEPTION 'luis-garcia still resolves to % rows', v_n; END IF;
END $$;
