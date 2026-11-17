-- 2026-09-25 (PT) — the crosswalk's first finding: All Day's "Josh Allen" row
-- (cc742262…, the Bills QB, GSIS 00-0034857) carried EIGHT Jacksonville
-- Jaguars editions labelled "Josh Allen" — the Jaguars linebacker, whom the
-- league now spells Josh Hines-Allen (GSIS 00-0035642) and who already has his
-- own row (98d2d5f9…, linked to that identity). The name-only linker put a
-- Jaguars label on the Bills row because it was the one row of that name;
-- match_player_identities (20260925225610) linked the QB by TEAM (BUF) and the
-- Jaguars editions stood out as the contradiction. Same shape as the Marvin
-- Harrison split (20260925212218): the edition's team_name is the discriminator.
--
-- Revert: UPDATE editions e SET player_id = b.player_id FROM
-- audit_20260925_suffix_editions_backup b WHERE b.edition_id = e.id AND
-- e.player_id = '98d2d5f9-25c1-4a7b-819f-ec117fafae51'.
DO $$
DECLARE v_qb uuid := 'cc742262-8547-4956-a807-a7cba00baf42';
        v_lb uuid := '98d2d5f9-25c1-4a7b-819f-ec117fafae51';
        v_n int;
BEGIN
  IF (SELECT name FROM public.players WHERE id = v_qb) <> 'Josh Allen'
     OR (SELECT name FROM public.players WHERE id = v_lb) <> 'Josh Hines-Allen' THEN
    RAISE EXCEPTION 'josh allen split: rows are not the ones this migration was written against';
  END IF;
  INSERT INTO public.audit_20260925_suffix_editions_backup (edition_id, player_id)
  SELECT e.id, e.player_id FROM public.editions e
   WHERE e.player_id = v_qb AND e.team_name = 'Jacksonville Jaguars'
  ON CONFLICT (edition_id) DO NOTHING;
  UPDATE public.editions SET player_id = v_lb
   WHERE player_id = v_qb AND team_name = 'Jacksonville Jaguars';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 8 THEN RAISE EXCEPTION 'josh allen split: moved % editions, expected 8', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.editions WHERE player_id = v_qb AND team_name <> 'Buffalo Bills') THEN
    RAISE EXCEPTION 'josh allen split: the QB row still carries a non-Bills edition';
  END IF;
END $$;
