-- audit_20260927_pinnacle_catalog_characters_get_a_page
--
-- WHY. A Pinnacle character page resolves only when public.players holds a row
-- for the character (get_player_detail's candidate set). The 2026-09-26 fix
-- (20260926164840) writes that row from pinnacle_editions — SET-level legacy
-- keys that name one character each and are written from wallet holdings — so
-- a character that exists only in the render catalog never gets one. Character
-- pages are keyed by the catalog's `characters` TRAIT (the overview hubs, the
-- pin page and the sitemap link it). Measured 2026-09-27: 5 of 513 trait names
-- had no row (all five from Ratatouille Vol.2, first seen 2:38 PM PT that day),
-- and every future catalog-only character would join them.
--
-- WHAT. A trigger on pinnacle_catalog (AFTER INSERT, and UPDATE OF characters
-- when the array actually changes) calls the existing, idempotent
-- pinnacle_ensure_character_player for each trait value, with team = the pin's
-- first franchise with ™/®/© dropped (the key get_team_detail resolves, so the
-- character page's franchise link works; no stored team carries the mark).
-- Plus a one-time backfill over the catalog (most common franchise per
-- character), which is a no-op for every character that already has a row.
--
-- ⚠ A trigger has no textual caller: grepping for players inserts will not
-- find this writer (the function comment names it).
--
-- Revert:
--   DROP TRIGGER IF EXISTS pinnacle_catalog_ensure_character_players_trg ON public.pinnacle_catalog;
--   DROP FUNCTION IF EXISTS public.pinnacle_catalog_ensure_character_players_tg();
--   (backfilled rows: DELETE FROM players WHERE external_id IN (<the names this migration logged>) — they are
--    ordinary character rows; leaving them is harmless.)

-- anon-exec: intentional — pinnacle_catalog_ensure_character_players_tg is REVOKEd below; a trigger function is fired by the trigger machinery, not by EXECUTE.
CREATE OR REPLACE FUNCTION public.pinnacle_catalog_ensure_character_players_tg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_team text;
  v_char text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.characters IS DISTINCT FROM OLD.characters THEN
    v_team := NULLIF(btrim(regexp_replace(COALESCE(NEW.franchises[1], ''), '[™®©]', '', 'g')), '');
    FOREACH v_char IN ARRAY COALESCE(NEW.characters, ARRAY[]::text[]) LOOP
      PERFORM public.pinnacle_ensure_character_player(v_char, v_team);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.pinnacle_catalog_ensure_character_players_tg() IS
  'Trigger on pinnacle_catalog: every Characters-trait value gets the players row its /disney-pinnacle/player/<slug> page needs (via pinnacle_ensure_character_player). Migration audit_20260927_pinnacle_catalog_characters_get_a_page.';

REVOKE EXECUTE ON FUNCTION public.pinnacle_catalog_ensure_character_players_tg()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pinnacle_catalog_ensure_character_players_trg ON public.pinnacle_catalog;
CREATE TRIGGER pinnacle_catalog_ensure_character_players_trg
  AFTER INSERT OR UPDATE OF characters ON public.pinnacle_catalog
  FOR EACH ROW EXECUTE FUNCTION public.pinnacle_catalog_ensure_character_players_tg();

-- One-time backfill: one call per trait value, its most common first franchise as team.
SELECT public.pinnacle_ensure_character_player(c.name, c.team)
FROM (
  SELECT btrim(ch) AS name,
         mode() WITHIN GROUP (ORDER BY NULLIF(btrim(regexp_replace(COALESCE(pc.franchises[1], ''), '[™®©]', '', 'g')), '')) AS team
  FROM public.pinnacle_catalog pc
  CROSS JOIN LATERAL unnest(pc.characters) AS ch
  WHERE btrim(ch) <> ''
  GROUP BY btrim(ch)
  ORDER BY count(*) DESC, btrim(ch)
) c;
