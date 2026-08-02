-- DB invariant: public.upsert_player_canonical(uuid, text, text, text, text, text, integer)
-- — the canonical player write path for app/api/ingest (shipped 2026-08-02 to replace
-- a blind .upsert() that clobbered players.team on every sale). get_player_detail
-- returns players.team DIRECTLY, so an overwrite here renders a wrong team on the
-- public player page; a bad cross-collection branch raises 23505 on a hot ingest
-- path; a missed adoption re-fragments a player. The whole value is that enrichable
-- columns are COALESCE FILL-ONLY and a teamAtMoment can never clobber a derived team.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802181500_audit_20260802_snapshot_upsert_player_canonical.sql);
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
  collection    text,
  name          text,
  first_name    text,
  last_name     text,
  team          text,
  jersey_number integer,
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE editions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid
);

-- >>> BEGIN verbatim upsert_player_canonical (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.upsert_player_canonical(p_collection_id uuid, p_external_id text, p_name text, p_first_name text DEFAULT NULL::text, p_last_name text DEFAULT NULL::text, p_team text DEFAULT NULL::text, p_jersey_number integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug       text;
  v_coll_slug  text;
  v_id         uuid;
  v_row_coll   uuid;
  v_row_ext    text;
  v_blocked    boolean := false;
  v_team       text := nullif(trim(coalesce(p_team, '')), '');
  v_name       text := nullif(trim(coalesce(p_name, '')), '');
BEGIN
  IF p_collection_id IS NULL
     OR p_external_id IS NULL OR trim(p_external_id) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(coalesce(v_name, ''))), '[^a-z0-9]+', '-', 'g');

  -- 1. exact external_id hit (external_id is GLOBALLY unique, so at most one row)
  SELECT p.id, p.collection_id INTO v_id, v_row_coll
    FROM public.players p
   WHERE p.external_id = p_external_id;

  IF v_id IS NOT NULL THEN
    IF v_row_coll IS DISTINCT FROM p_collection_id THEN
      -- the id belongs to a DIFFERENT collection; never mutate that row, and an
      -- INSERT here would violate the global unique. Fall through to slug
      -- resolution, but forbid inserting.
      v_blocked := true;
      v_id := NULL;
    ELSE
      UPDATE public.players p SET
        name          = COALESCE(v_name, p.name),
        first_name    = COALESCE(p.first_name,    p_first_name),
        last_name     = COALESCE(p.last_name,     p_last_name),
        team          = COALESCE(p.team,          v_team),
        jersey_number = COALESCE(p.jersey_number, p_jersey_number),
        updated_at    = now()
      WHERE p.id = v_id;
      RETURN v_id;
    END IF;
  END IF;

  -- 2. canonical resolution by (collection_id, name-slug)
  IF v_slug <> '' THEN
    SELECT p.id, p.external_id INTO v_id, v_row_ext
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
      -- adopt the canonical numeric stats id onto a slug-scheme row when free
      IF p_external_id ~ '^[0-9]+$'
         AND v_row_ext !~ '^[0-9]+$'
         AND NOT EXISTS (SELECT 1 FROM public.players x WHERE x.external_id = p_external_id)
      THEN
        UPDATE public.players SET external_id = p_external_id WHERE id = v_id;
      END IF;

      UPDATE public.players p SET
        name          = COALESCE(v_name, p.name),
        first_name    = COALESCE(p.first_name,    p_first_name),
        last_name     = COALESCE(p.last_name,     p_last_name),
        team          = COALESCE(p.team,          v_team),
        jersey_number = COALESCE(p.jersey_number, p_jersey_number),
        updated_at    = now()
      WHERE p.id = v_id;

      RETURN v_id;
    END IF;
  END IF;

  -- 3. cross-collection collision and no slug match -> cannot insert safely
  IF v_blocked THEN
    RETURN NULL;
  END IF;

  -- 4. genuinely new player
  SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;

  INSERT INTO public.players (external_id, collection_id, collection, name,
                              first_name, last_name, team, jersey_number)
  VALUES (p_external_id, p_collection_id, coalesce(v_coll_slug, 'unknown'),
          coalesce(v_name, 'Unknown Player'),
          p_first_name, p_last_name, v_team, p_jersey_number)
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- lost an insert race: re-resolve
    SELECT p.id INTO v_id FROM public.players p WHERE p.external_id = p_external_id;
    IF v_id IS NULL AND v_slug <> '' THEN
      SELECT p.id INTO v_id
        FROM public.players p
       WHERE p.collection_id = p_collection_id
         AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
       LIMIT 1;
    END IF;
  END IF;

  RETURN v_id;
END
$function$;
-- <<< END verbatim upsert_player_canonical <<<

INSERT INTO collections (id, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'nba_top_shot'),
  ('22222222-2222-2222-2222-222222222222', 'nfl_all_day');

-- Guard rails.
SELECT _assert_eq(upsert_player_canonical(NULL, '2738', 'X')::text, NULL, 'NULL collection → NULL');
SELECT _assert_eq(upsert_player_canonical('11111111-1111-1111-1111-111111111111', '   ', 'X')::text, NULL, 'blank external_id → NULL');

-- Exact external_id hit in the SAME collection → COALESCE fill-only. team is
-- pre-set and must NOT be overwritten; first_name/last_name/jersey_number fill
-- because they are NULL; name follows the provided value (authoritative-on-provide).
INSERT INTO players (id, external_id, collection_id, collection, name, first_name, last_name, team, jersey_number) VALUES
  ('00000000-0000-0000-0000-000000000001', '2738', '11111111-1111-1111-1111-111111111111', 'nba_top_shot',
   'LeBron James', NULL, NULL, 'Los Angeles Lakers', NULL);
SELECT upsert_player_canonical('11111111-1111-1111-1111-111111111111', '2738', 'LeBron R James',
       p_first_name => 'LeBron', p_last_name => 'James', p_team => 'Miami Heat', p_jersey_number => 6);
SELECT _assert_eq((SELECT team          FROM players WHERE external_id='2738'), 'Los Angeles Lakers', 'exact-id: team NOT overwritten (fill-only)');
SELECT _assert_eq((SELECT first_name    FROM players WHERE external_id='2738'), 'LeBron',              'exact-id: first_name filled when NULL');
SELECT _assert_eq((SELECT last_name     FROM players WHERE external_id='2738'), 'James',               'exact-id: last_name filled when NULL');
SELECT _assert_eq((SELECT jersey_number::text FROM players WHERE external_id='2738'), '6',             'exact-id: jersey filled when NULL');
SELECT _assert_eq((SELECT name          FROM players WHERE external_id='2738'), 'LeBron R James',       'exact-id: name follows provided (authoritative-on-provide)');
SELECT _assert_eq((SELECT count(*)::text FROM players), '1', 'exact-id hit does not insert');

-- Cross-collection external_id collision → NULL, and the foreign row is untouched.
INSERT INTO players (id, external_id, collection_id, collection, name, team) VALUES
  ('00000000-0000-0000-0000-000000000002', 'shared-9999', '22222222-2222-2222-2222-222222222222', 'nfl_all_day',
   'Foreign Guy', 'Team A');
SELECT _assert_eq(
  upsert_player_canonical('11111111-1111-1111-1111-111111111111', 'shared-9999', 'Different Name', p_team => 'Team B')::text,
  NULL, 'external_id in a DIFFERENT collection → NULL (blocked, cannot insert)');
SELECT _assert_eq((SELECT team FROM players WHERE external_id='shared-9999'), 'Team A', 'foreign-collection row NOT mutated by the blocked call');
SELECT _assert_eq((SELECT name FROM players WHERE external_id='shared-9999'), 'Foreign Guy', 'foreign-collection row name NOT mutated');

-- Numeric-id adoption: a flow:<playID> row is resolved by slug and the free
-- numeric stats id is adopted onto it (no new row), then filled.
INSERT INTO players (id, external_id, collection_id, collection, name, team) VALUES
  ('00000000-0000-0000-0000-000000000003', 'flow:555', '11111111-1111-1111-1111-111111111111', 'nba_top_shot',
   'Adopt Me', NULL);
SELECT upsert_player_canonical('11111111-1111-1111-1111-111111111111', '777', 'Adopt Me', p_team => 'Team X');
SELECT _assert_eq((SELECT external_id FROM players WHERE id='00000000-0000-0000-0000-000000000003'), '777',
  'slug path: free numeric stats id adopted onto the flow:<playID> row');
SELECT _assert(( NOT EXISTS (SELECT 1 FROM players WHERE external_id='flow:555') ),
  'slug path: the old flow: external_id no longer exists (adopted, not duplicated)');
SELECT _assert_eq((SELECT team FROM players WHERE id='00000000-0000-0000-0000-000000000003'), 'Team X',
  'slug path: team filled when NULL');

-- Genuinely new player → INSERT with the collection slug + supplied fields.
SELECT upsert_player_canonical('11111111-1111-1111-1111-111111111111', 'brand-1', 'Brand New', p_team => 'Team Z', p_jersey_number => 23);
SELECT _assert_eq((SELECT collection FROM players WHERE external_id='brand-1'), 'nba_top_shot', 'new player: collection slug set');
SELECT _assert_eq((SELECT team FROM players WHERE external_id='brand-1'), 'Team Z', 'new player: team stored');
SELECT _assert_eq((SELECT jersey_number::text FROM players WHERE external_id='brand-1'), '23', 'new player: jersey stored');

-- New player with a blank name → 'Unknown Player' placeholder.
SELECT upsert_player_canonical('11111111-1111-1111-1111-111111111111', 'noname-1', NULL);
SELECT _assert_eq((SELECT name FROM players WHERE external_id='noname-1'), 'Unknown Player', 'new player, blank name → Unknown Player');

SELECT '✓ upsert_player_canonical invariants pass' AS result;
ROLLBACK;
