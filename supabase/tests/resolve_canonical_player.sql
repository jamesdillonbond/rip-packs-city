-- DB invariant: public.resolve_canonical_player(uuid, text, text) — the canonical
-- resolve-or-create for a player keyed on (collection_id, name-slug). Introduced
-- 2026-08-01 for the Top Shot players dedupe: wallet-search had minted one player
-- row per playID (external_id 'flow:<playID>'), so a single athlete fragmented
-- across many rows; this function collapses them to one canonical row and every
-- new caller resolves-or-creates through it. A wrong result re-fragments players
-- or misattributes editions to the wrong player.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802181000_audit_20260802_snapshot_resolve_canonical_player.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (
  id   uuid PRIMARY KEY,
  slug text
);

CREATE TABLE players (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE,
  collection_id uuid,
  name          text,
  team          text,
  collection    text,
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE editions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid
);

-- >>> BEGIN verbatim resolve_canonical_player (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_canonical_player(p_collection_id uuid, p_name text, p_team text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug      text;
  v_coll_slug text;
  v_id        uuid;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g');
  IF v_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO v_id
    FROM public.players p
   WHERE p.collection_id = p_collection_id
     AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
   ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$'  THEN 1
                 WHEN p.external_id LIKE 'flow:%' THEN 3
                 ELSE 2 END,
            (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) DESC,
            p.id
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    IF p_team IS NOT NULL AND trim(p_team) <> '' THEN
      UPDATE public.players SET team = p_team, updated_at = now()
       WHERE id = v_id AND team IS NULL;
    END IF;
    RETURN v_id;
  END IF;

  SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;

  INSERT INTO public.players (external_id, collection_id, name, team, collection)
  VALUES (coalesce(v_coll_slug, 'unknown') || '-' || v_slug,
          p_collection_id, trim(p_name), nullif(trim(coalesce(p_team, '')), ''),
          coalesce(v_coll_slug, 'unknown'))
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT p.id INTO v_id
      FROM public.players p
     WHERE p.collection_id = p_collection_id
       AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
     LIMIT 1;
  END IF;

  RETURN v_id;
END
$function$;
-- <<< END verbatim resolve_canonical_player <<<

-- Collection + fixture players. Two share the slug 'lebron-james': the canonical
-- numeric-external_id row (rank 1) and a 'flow:<playID>' fossil (rank 3).
INSERT INTO collections (id, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'nba_top_shot');

INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000001', '2738',       '11111111-1111-1111-1111-111111111111', 'LeBron James', NULL, 'nba_top_shot'),
  ('00000000-0000-0000-0000-000000000002', 'flow:2738',  '11111111-1111-1111-1111-111111111111', 'LeBron James', NULL, 'nba_top_shot');

-- Guard rails: null/blank name or null collection never mints a row.
SELECT _assert_eq(resolve_canonical_player('11111111-1111-1111-1111-111111111111', NULL)::text, NULL, 'NULL name → NULL');
SELECT _assert_eq(resolve_canonical_player('11111111-1111-1111-1111-111111111111', '   ')::text, NULL, 'blank name → NULL');
SELECT _assert_eq(resolve_canonical_player(NULL, 'LeBron James')::text, NULL, 'NULL collection → NULL');

-- Existing match: case-insensitive + whitespace-collapsing slug (leading/trailing
-- spaces are trimmed; interior runs collapse to one '-'), and the
-- numeric-external_id canonical row wins the tie-break over the flow:<playID>
-- fossil. NOTE: normalization does NOT strip edge dashes, so a trailing
-- punctuation char (e.g. 'James!') yields a trailing '-' and would MISS — the
-- probe here normalizes to exactly 'lebron-james'.
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', '  leBRON   JAMES  ')::text,
  '00000000-0000-0000-0000-000000000001',
  'slug-normalized match resolves to the numeric-id canonical row, not the flow: fossil');

-- No new row was minted for the existing match.
SELECT _assert_eq((SELECT count(*)::text FROM players), '2', 'existing match does not insert');

-- Team backfill: fills team only when it is currently NULL.
INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000003', 'ext-team', '11111111-1111-1111-1111-111111111111', 'Team Guy', NULL, 'nba_top_shot');
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Team Guy', 'Trail Blazers');
SELECT _assert_eq((SELECT team FROM players WHERE external_id='ext-team'), 'Trail Blazers', 'team backfilled when NULL');
-- A second call with a different team must NOT overwrite the set value.
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Team Guy', 'Lakers');
SELECT _assert_eq((SELECT team FROM players WHERE external_id='ext-team'), 'Trail Blazers', 'team NOT overwritten once set');

-- Edition-count tie-break among two non-numeric, non-flow rows with the same slug:
-- the one with MORE editions wins.
INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000004', 'ext-dup-a', '11111111-1111-1111-1111-111111111111', 'Dup Name', NULL, 'nba_top_shot'),
  ('00000000-0000-0000-0000-000000000005', 'ext-dup-b', '11111111-1111-1111-1111-111111111111', 'Dup Name', NULL, 'nba_top_shot');
INSERT INTO editions (player_id) VALUES
  ('00000000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000005');
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Dup Name')::text,
  '00000000-0000-0000-0000-000000000005',
  'edition-count tie-break: the row with more editions wins');

-- No match → inserts a new canonical row keyed '<collection-slug>-<name-slug>'.
-- (Insert in its own statement first: argument evaluation order within a single
-- call is unspecified, so a lookup subquery co-passed with the inserting call can
-- run BEFORE the insert.)
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Fresh  Rookie');
SELECT _assert(( (SELECT count(*) FROM players WHERE external_id='nba_top_shot-fresh-rookie') = 1 ),
  'no match → inserts one <collection-slug>-<name-slug> row');
SELECT _assert_eq((SELECT name FROM players WHERE external_id='nba_top_shot-fresh-rookie'), 'Fresh  Rookie',
  'new row stores the trimmed name');
-- With no team supplied the new row's team stays NULL (nullif(trim('')) → NULL).
SELECT _assert(( (SELECT team FROM players WHERE external_id='nba_top_shot-fresh-rookie') IS NULL ),
  'new row with no team → team NULL');
-- A second call is idempotent: it now resolves the just-created row (no new insert).
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Fresh  Rookie')::text,
  (SELECT id::text FROM players WHERE external_id='nba_top_shot-fresh-rookie'),
  'second call resolves to the same row (idempotent), mints no duplicate');

SELECT '✓ resolve_canonical_player invariants pass' AS result;
ROLLBACK;
