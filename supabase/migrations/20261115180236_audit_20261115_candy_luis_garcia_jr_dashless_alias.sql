-- 2026-11-15 (PT) — follow-on to 20261115180005. "Luis García Jr." slugs to `luis-garcia-jr-` (the
-- trailing period becomes a dash, the same convention as cal-ripken-jr- / marcus-morris-sr-), so the
-- dashless `/candy-mlb/player/luis-garcia-jr` rendered the header with NO editions (get_player_editions
-- matches the slug exactly; measured 0 vs 3). Register the dashless spelling as an alias so it 308s to
-- the canonical page like every other alternate spelling.
-- Revert: DELETE FROM public.player_name_aliases WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' AND alias_slug = 'luis-garcia-jr';
INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
VALUES ('209ade70-32c5-4470-bc7c-4793d660f713', 'luis-garcia-jr', '462c23be-48d9-4685-a01f-0b9e80510ba7',
        '2026-11-15: dashless URL of "Luis García Jr." (canonical slug luis-garcia-jr-)')
ON CONFLICT (collection_id, alias_slug) DO NOTHING;
DO $$
BEGIN
  IF public.get_player_alias_target('209ade70-32c5-4470-bc7c-4793d660f713', 'luis-garcia-jr') IS DISTINCT FROM 'luis-garcia-jr-' THEN
    RAISE EXCEPTION 'luis-garcia-jr does not alias to luis-garcia-jr- (got %)',
      public.get_player_alias_target('209ade70-32c5-4470-bc7c-4793d660f713', 'luis-garcia-jr');
  END IF;
END $$;
