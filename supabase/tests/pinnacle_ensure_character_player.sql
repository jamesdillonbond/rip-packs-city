-- DB invariant: public.pinnacle_ensure_character_player + its pinnacle_editions
-- trigger. Added 2026-09-26: every Pinnacle players row came from a one-time
-- 2026-05-05 seed, so 127 of 249 characters had no row and their character
-- pages (/disney-pinnacle/player/<slug>) 404'd. Claims it must keep:
--
--   1. A new character gets exactly one players row, keyed disney_pinnacle-<slug>,
--      team = the franchise it was given, is_active.
--   2. Idempotent: a second call, or a CASE VARIANT of an existing name
--      ("ANAKIN'S PODRACER" / "Anakin's Podracer"), writes nothing.
--   3. 'Unknown' (the stub placeholder), NULL and blank write nothing.
--   4. The trigger fires on INSERT and on a changed character_name only.
--   5. Another collection's row with the same slug does not count as present.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926164840_audit_20260926_pinnacle_characters_get_a_page_the_day_they_mint.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id varchar UNIQUE,
  collection_id uuid,
  collection text NOT NULL DEFAULT 'nba_top_shot',
  name varchar NOT NULL,
  team varchar,
  is_active boolean DEFAULT true
);
CREATE TABLE public.pinnacle_editions (id text PRIMARY KEY, character_name text, franchise text);

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

CREATE TRIGGER pinnacle_editions_ensure_character_player_trg
  AFTER INSERT OR UPDATE OF character_name ON public.pinnacle_editions
  FOR EACH ROW EXECUTE FUNCTION public.pinnacle_editions_ensure_character_player_tg();

-- A seeded row, spelled in capitals, and a Top Shot row sharing a slug.
INSERT INTO public.players (external_id, collection_id, collection, name, team)
VALUES ('disney_pinnacle-anakin-s-podracer', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'disney_pinnacle', 'ANAKIN''S PODRACER', 'Star Wars'),
       ('topshot-tinker-bell', '00000000-0000-0000-0000-000000000001', 'nba_top_shot', 'Tinker Bell', 'X');

-- 1 + 5: a new character via the trigger, despite the other collection's row.
INSERT INTO public.pinnacle_editions VALUES ('e1', 'Tinker Bell', 'Peter Pan');
SELECT _assert_eq(
  (SELECT external_id || '|' || team || '|' || collection || '|' || is_active::text FROM public.players
    WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714' AND name = 'Tinker Bell'),
  'disney_pinnacle-tinker-bell|Peter Pan|disney_pinnacle|true',
  'a new character gets its row, keyed disney_pinnacle-<slug>, team = franchise');

-- 2: a second edition of the same character, a direct re-call, and a case variant.
INSERT INTO public.pinnacle_editions VALUES ('e2', 'Tinker Bell', 'Disney Fairies');
SELECT public.pinnacle_ensure_character_player('  tinker bell ', 'Other');
INSERT INTO public.pinnacle_editions VALUES ('e3', 'Anakin''s Podracer', 'Star Wars');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.players WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'),
  '2', 'repeats and case variants write nothing');
SELECT _assert_eq(
  (SELECT team FROM public.players WHERE external_id = 'disney_pinnacle-tinker-bell'),
  'Peter Pan', 'an existing row is never overwritten');

-- 3: placeholders.
INSERT INTO public.pinnacle_editions VALUES ('e4', 'Unknown', 'Unknown'), ('e5', NULL, 'X'), ('e6', '   ', 'X');
SELECT public.pinnacle_ensure_character_player('UNKNOWN', 'X');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.players WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'),
  '2', 'Unknown / NULL / blank never get a page');

-- 4: an update that does not touch character_name fires nothing; a rename does.
UPDATE public.pinnacle_editions SET franchise = 'Changed' WHERE id = 'e1';
UPDATE public.pinnacle_editions SET character_name = 'Buzz Lightyear', franchise = 'Toy Story' WHERE id = 'e4';
SELECT _assert_eq(
  (SELECT string_agg(name, ',' ORDER BY name) FROM public.players WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'),
  'ANAKIN''S PODRACER,Buzz Lightyear,Tinker Bell', 'a rename away from Unknown gets its row');

ROLLBACK;
