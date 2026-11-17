-- DB invariant: public.normalize_player_name_alias() — the BEFORE trigger that
-- rewrites a registered ALIAS spelling of a player's name (player_name_aliases)
-- to the player's canonical name, so one person is never labelled two ways
-- across editions and the refreshed caches (Steph / Stephen Curry, #137 a).
-- A wrong result re-splits a player's labels, or rewrites a name that is not an
-- alias.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260925150357_audit_20260925_one_curry_name_everywhere_alias_normalizer_and_search.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE players (
  id   uuid PRIMARY KEY,
  name text
);
CREATE TABLE player_name_aliases (
  collection_id uuid NOT NULL,
  alias_slug    text NOT NULL,
  player_id     uuid NOT NULL,
  PRIMARY KEY (collection_id, alias_slug)
);
CREATE TABLE editions (
  id            serial PRIMARY KEY,
  collection_id uuid,
  player_name   text,
  name          text
);
CREATE TABLE ts_listings (
  listing_id  serial PRIMARY KEY,
  player_name text
);

-- >>> BEGIN verbatim normalize_player_name_alias (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.normalize_player_name_alias()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll uuid;
  v_slug text;
  v_name text;
BEGIN
  IF NEW.player_name IS NULL OR btrim(NEW.player_name) = '' THEN
    RETURN NEW;
  END IF;
  -- a table without a collection_id column passes its collection as the argument
  IF TG_NARGS > 0 THEN
    v_coll := TG_ARGV[0]::uuid;
  ELSE
    v_coll := NEW.collection_id;
  END IF;
  IF v_coll IS NULL THEN
    RETURN NEW;
  END IF;

  v_slug := regexp_replace(lower(trim(extensions.unaccent(NEW.player_name))), '[^a-z0-9]+', '-', 'g');
  SELECT p.name INTO v_name
    FROM public.player_name_aliases a
    JOIN public.players p ON p.id = a.player_id
   WHERE a.collection_id = v_coll
     AND a.alias_slug = v_slug;
  IF v_name IS NULL OR v_name = NEW.player_name THEN
    RETURN NEW;
  END IF;

  -- editions also carry the house label "<player> — <set>". Nested, never one
  -- AND: PL/pgSQL does not short-circuit, and NEW.name does not exist on the
  -- cache tables this trigger also serves.
  IF TG_TABLE_NAME = 'editions' THEN
    IF NEW.name IS NOT NULL AND starts_with(NEW.name, NEW.player_name || ' ') THEN
      NEW.name := v_name || substr(NEW.name, length(NEW.player_name) + 1);
    END IF;
  END IF;
  NEW.player_name := v_name;
  RETURN NEW;
END
$function$;
-- <<< END verbatim normalize_player_name_alias <<<

CREATE TRIGGER a_normalize_player_name_alias_ins BEFORE INSERT ON editions
  FOR EACH ROW WHEN (NEW.player_name IS NOT NULL) EXECUTE FUNCTION normalize_player_name_alias();
CREATE TRIGGER a_normalize_player_name_alias_upd BEFORE UPDATE OF player_name ON editions
  FOR EACH ROW WHEN (NEW.player_name IS DISTINCT FROM OLD.player_name) EXECUTE FUNCTION normalize_player_name_alias();
CREATE TRIGGER a_normalize_player_name_alias_ins BEFORE INSERT ON ts_listings
  FOR EACH ROW WHEN (NEW.player_name IS NOT NULL)
  EXECUTE FUNCTION normalize_player_name_alias('11111111-1111-1111-1111-111111111111');

INSERT INTO players VALUES ('00000000-0000-0000-0000-000000000007', 'Steph Curry');
INSERT INTO player_name_aliases VALUES
  ('11111111-1111-1111-1111-111111111111', 'stephen-curry', '00000000-0000-0000-0000-000000000007');

-- An alias spelling is rewritten to the canonical name, and the house label with it.
INSERT INTO editions (collection_id, player_name, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Stephen Curry', 'Stephen Curry — Metallic Gold LE');
SELECT _assert_eq((SELECT player_name FROM editions WHERE id = 1), 'Steph Curry', 'alias spelling → canonical name');
SELECT _assert_eq((SELECT name FROM editions WHERE id = 1), 'Steph Curry — Metallic Gold LE', 'house label follows the name');

-- Case, spacing and accents fold before the alias lookup.
INSERT INTO editions (collection_id, player_name, name) VALUES
  ('11111111-1111-1111-1111-111111111111', '  STEPHEN   curry ', NULL);
SELECT _assert_eq((SELECT player_name FROM editions WHERE id = 2), 'Steph Curry', 'normalized slug matches the alias');

-- UPDATE path: a refresh that writes the alias spelling back is corrected.
UPDATE editions SET player_name = 'Stephen Curry' WHERE id = 1;
SELECT _assert_eq((SELECT player_name FROM editions WHERE id = 1), 'Steph Curry', 'an UPDATE to the alias is corrected');

-- No-change controls: another name, the same spelling in another collection, a
-- label that does not start with the player's name, and NULL all pass through.
INSERT INTO editions (collection_id, player_name, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'LeBron James', 'LeBron James — Base'),
  ('22222222-2222-2222-2222-222222222222', 'Stephen Curry', 'Stephen Curry — Other League'),
  (NULL, 'Stephen Curry', NULL),
  ('11111111-1111-1111-1111-111111111111', NULL, 'Team Moment');
SELECT _assert_eq((SELECT player_name FROM editions WHERE id = 3), 'LeBron James', 'an unaliased name is untouched');
SELECT _assert_eq((SELECT name FROM editions WHERE id = 4), 'Stephen Curry — Other League', 'aliases are scoped to their collection');
SELECT _assert_eq((SELECT player_name FROM editions WHERE id = 5), 'Stephen Curry', 'no collection → untouched');
SELECT _assert(((SELECT player_name FROM editions WHERE id = 6) IS NULL), 'NULL player_name stays NULL');

-- A table without collection_id passes the collection as the trigger argument.
INSERT INTO ts_listings (player_name) VALUES ('Stephen Curry'), ('Klay Thompson');
SELECT _assert_eq((SELECT player_name FROM ts_listings WHERE listing_id = 1), 'Steph Curry', 'argument-scoped table is normalized');
SELECT _assert_eq((SELECT player_name FROM ts_listings WHERE listing_id = 2), 'Klay Thompson', 'argument-scoped no-change control');

SELECT '✓ normalize_player_name_alias invariants pass' AS result;
ROLLBACK;
