-- DB invariant: public.pinnacle_catalog_ensure_character_players_tg — the
-- trigger that gives every Pinnacle Characters-trait value a players row, so its
-- /disney-pinnacle/player/<slug> page resolves. Added 2026-09-27: the 09-26
-- writer fires on pinnacle_editions only, so catalog-only characters had no page.
--
-- Claims:
--   1. INSERT of a pin writes one row per trait value, team = its first
--      franchise with the trademark sign dropped (the key get_team_detail resolves).
--   2. An UPDATE that leaves `characters` unchanged writes nothing new; one that
--      adds a character writes that character.
--   3. A case variant of an existing name, an empty array and NULL write nothing.
--
-- The trigger-function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260928111652_audit_20260927_pinnacle_catalog_characters_get_a_page.sql).
-- pinnacle_ensure_character_player is copied from its own migration (pinned
-- separately in supabase/tests/pinnacle_ensure_character_player.sql).
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
CREATE TABLE public.pinnacle_catalog (render_id text PRIMARY KEY, characters text[], franchises text[]);

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

-- >>> BEGIN verbatim pinnacle_catalog_ensure_character_players_tg >>>
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
-- <<< END verbatim pinnacle_catalog_ensure_character_players_tg <<<

CREATE TRIGGER pinnacle_catalog_ensure_character_players_trg
  AFTER INSERT OR UPDATE OF characters ON public.pinnacle_catalog
  FOR EACH ROW EXECUTE FUNCTION public.pinnacle_catalog_ensure_character_players_tg();

\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''

-- ── 1. INSERT: one row per trait value, franchise without the mark ──────────
INSERT INTO public.pinnacle_catalog VALUES ('PAS-RATA-REMY-S1', ARRAY['Remy', 'Emile'], ARRAY['Ratatouille™', 'Pixar']);
SELECT _assert_eq((SELECT count(*)::text FROM public.players WHERE collection_id = :PIN::uuid), '2', 'two trait values -> two players rows');
SELECT _assert_eq((SELECT team::text FROM public.players WHERE name = 'Remy'), 'Ratatouille', 'team = first franchise with the trademark sign dropped');
SELECT _assert_eq((SELECT external_id::text FROM public.players WHERE name = 'Emile'), 'disney_pinnacle-emile', 'keyed disney_pinnacle-<slug>');

-- ── 2. UPDATE: unchanged characters -> nothing; an added character -> its row ─
UPDATE public.pinnacle_catalog SET characters = ARRAY['Remy', 'Emile'] WHERE render_id = 'PAS-RATA-REMY-S1';
SELECT _assert_eq((SELECT count(*)::text FROM public.players), '2', 'unchanged characters write nothing');
UPDATE public.pinnacle_catalog SET characters = ARRAY['Remy', 'Emile', 'Linguini'] WHERE render_id = 'PAS-RATA-REMY-S1';
SELECT _assert_eq((SELECT count(*)::text FROM public.players WHERE name = 'Linguini'), '1', 'an added character gets its row');

-- ── 3. case variant / empty / NULL write nothing ─────────────────────────────
INSERT INTO public.pinnacle_catalog VALUES ('PAS-RATA-REMY-S2', ARRAY['REMY'], ARRAY['Ratatouille™']);
INSERT INTO public.pinnacle_catalog VALUES ('X-EMPTY', ARRAY[]::text[], ARRAY['Pixar']);
INSERT INTO public.pinnacle_catalog VALUES ('X-NULL', NULL, NULL);
SELECT _assert_eq((SELECT count(*)::text FROM public.players), '3', 'case variant, empty array and NULL add no rows');

SELECT '✓ pinnacle_catalog_ensure_character_players_tg: all assertions passed' AS result;

ROLLBACK;
