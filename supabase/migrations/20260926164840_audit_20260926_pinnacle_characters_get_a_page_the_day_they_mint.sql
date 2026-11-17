-- audit_20260926_pinnacle_characters_get_a_page_the_day_they_mint
--
-- WHY. A Pinnacle character page (/disney-pinnacle/player/<slug>) resolves only
-- when public.players holds a row for that character — get_player_detail's
-- candidate set is `FROM players p WHERE p.collection_id = …`. Every Pinnacle
-- players row was written ONCE, on 2026-05-05, by a seed nothing maintains, so
-- every character minted since has no page. Measured 2026-09-26: 127 of the 249
-- distinct pinnacle_editions.character_name values had no row, and production
-- logged real 404s on /disney-pinnacle/player/tinker-bell and /buzz-lightyear.
--
-- WHAT.
--   1. public.pinnacle_ensure_character_player(name, franchise) inserts the
--      players row for one character if its slug has none. Idempotent through
--      the GLOBAL unique index on players.external_id, using the seed's own key
--      shape `disney_pinnacle-<slug>` — so a case variant of an existing name
--      ("ANAKIN'S PODRACER" vs "Anakin's Podracer") is a no-op, not a duplicate.
--   2. A row trigger on pinnacle_editions calls it on INSERT and on a change of
--      character_name, so a new character has a page the day it is ingested.
--   3. A one-time backfill of the 126 (127 minus the 'Unknown' stub placeholder), team = the character's MOST COMMON
--      franchise (the seed's convention: 116 of its 121 rows match that rule).
--
-- ⚠ SECURITY DEFINER, deliberately: the lanes that write pinnacle_editions are
--   not all granted INSERT on players, and an INVOKER trigger would turn a
--   missing grant into a FAILED EDITION INGEST. The function writes one fixed
--   table with ON CONFLICT DO NOTHING and takes no caller-controlled SQL.
-- ⚠ Not wrapped in an exception handler: a failure here should be loud, and the
--   only realistic conflict (an existing external_id) is absorbed by ON CONFLICT.
-- ⚠ A trigger has no textual caller — grepping for players inserts will not find
--   this writer. That is what the function comment is for.

-- anon-exec: intentional — pinnacle_ensure_character_player is REVOKEd below from PUBLIC, anon, authenticated; only the trigger (as owner) and postgres/service_role call it.
CREATE OR REPLACE FUNCTION public.pinnacle_ensure_character_player(p_name text, p_team text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name text := trim(p_name);
  v_slug text;
BEGIN
  -- 'Unknown' is the placeholder a fetch-missing stub row carries until the
  -- metadata backfill repairs it — a page for it would name no one.
  IF v_name IS NULL OR v_name = '' OR lower(v_name) = 'unknown' THEN
    RETURN;
  END IF;
  -- Same expression get_player_detail matches a URL slug against.
  v_slug := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
  -- A row whose NAME already slugs to this (whatever its external_id) is enough.
  IF EXISTS (
    SELECT 1 FROM public.players p
    WHERE p.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
      AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.players (external_id, collection_id, collection, name, team, is_active)
  VALUES (
    'disney_pinnacle-' || v_slug,
    '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid,
    'disney_pinnacle',
    v_name,
    NULLIF(trim(p_team), ''),
    true
  )
  ON CONFLICT (external_id) DO NOTHING;
END;
$function$;

COMMENT ON FUNCTION public.pinnacle_ensure_character_player(text, text) IS
  'Writes the public.players row a Pinnacle character page needs. Called by trigger pinnacle_editions_ensure_character_player_trg (AFTER INSERT / UPDATE OF character_name on pinnacle_editions). Idempotent. Migration audit_20260926_pinnacle_characters_get_a_page_the_day_they_mint.';

REVOKE EXECUTE ON FUNCTION public.pinnacle_ensure_character_player(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pinnacle_ensure_character_player(text, text)
  TO postgres, service_role;

-- anon-exec: intentional — pinnacle_editions_ensure_character_player_tg is REVOKEd below; a trigger function is fired by the trigger machinery, not by EXECUTE.
CREATE OR REPLACE FUNCTION public.pinnacle_editions_ensure_character_player_tg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.character_name IS DISTINCT FROM OLD.character_name THEN
    PERFORM public.pinnacle_ensure_character_player(NEW.character_name, NEW.franchise);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pinnacle_editions_ensure_character_player_tg()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pinnacle_editions_ensure_character_player_trg ON public.pinnacle_editions;
CREATE TRIGGER pinnacle_editions_ensure_character_player_trg
  AFTER INSERT OR UPDATE OF character_name ON public.pinnacle_editions
  FOR EACH ROW EXECUTE FUNCTION public.pinnacle_editions_ensure_character_player_tg();

-- One-time backfill. One call per character, most common franchise as team.
SELECT public.pinnacle_ensure_character_player(c.character_name, c.team)
FROM (
  SELECT trim(pe.character_name) AS character_name,
         mode() WITHIN GROUP (ORDER BY pe.franchise) AS team
  FROM public.pinnacle_editions pe
  WHERE pe.character_name IS NOT NULL AND trim(pe.character_name) <> ''
  GROUP BY trim(pe.character_name)
  ORDER BY count(*) DESC, trim(pe.character_name)
) c;
