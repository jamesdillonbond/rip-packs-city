-- DB invariant: public.ensure_topshot_edition_stub(integer,integer) — the self-heal
-- that lets a NEW Top Shot set resolve with no manual seeding. Pinned properties:
-- (1) FAST PATH — an existing edition is returned as-is, no insert; (2) DIRECT SET —
-- when the parent set already carries set_id_onchain, a stub is inserted inheriting
-- its tier/series/name; (3) SELF-HEAL BRIDGE — when the set exists only by its UUID
-- (external_id, set_id_onchain NULL), the fn backfills set_id_onchain from a sibling
-- edition's external_id prefix, then inserts the stub; (4) CATALOG GAP — no set and
-- no sibling → returns NULL and inserts nothing; (5) IDEMPOTENT on a repeat call.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802000600_audit_20260802_snapshot_ensure_topshot_edition_stub.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE tier_type AS ENUM ('COMMON','FANDOM','RARE','LEGENDARY','ULTIMATE','UNCOMMON','CHAMPION','CHALLENGER','CONTENDER');
CREATE TYPE edition_kind AS ENUM ('LE','CE','UL');

CREATE TABLE sets (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  external_id    text,
  collection_id  uuid,
  name           text,
  tier           tier_type,
  series         int,
  set_id_onchain int,
  updated_at     timestamptz
);
CREATE TABLE editions (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  external_id       text,
  collection_id     uuid,
  set_id            uuid,
  player_id         uuid,
  tier              tier_type,
  series            int,
  edition_kind      edition_kind,
  set_id_onchain    int,
  play_id_onchain   int,
  collection        text,
  set_name          text,
  created_at        timestamptz,
  updated_at        timestamptz,
  UNIQUE (external_id, collection_id)
);

-- >>> BEGIN verbatim ensure_topshot_edition_stub (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.ensure_topshot_edition_stub(p_set_id_onchain integer, p_play_id_onchain integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collection_id uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_edition_id uuid;
  v_set_uuid uuid;
  v_set_name text;
  v_set_tier tier_type;
  v_set_series int;
BEGIN
  -- Fast path: edition already exists
  SELECT id INTO v_edition_id
  FROM editions
  WHERE collection_id = v_collection_id
    AND set_id_onchain = p_set_id_onchain
    AND play_id_onchain = p_play_id_onchain
  LIMIT 1;

  IF v_edition_id IS NOT NULL THEN
    RETURN v_edition_id;
  END IF;

  -- Look up parent set to inherit defaults
  SELECT id, name, tier, series
    INTO v_set_uuid, v_set_name, v_set_tier, v_set_series
  FROM sets
  WHERE collection_id = v_collection_id
    AND set_id_onchain = p_set_id_onchain
  LIMIT 1;

  IF v_set_uuid IS NULL THEN
    -- Self-heal: the GQL editions-catalog creates `sets` rows keyed by the
    -- TopShot UUID (external_id) but does not populate set_id_onchain, so the
    -- lookup above misses. Bridge via a sibling edition that carries both the
    -- UUID (external_id prefix) and the integer set_id_onchain, and backfill
    -- set_id_onchain onto the existing sets row so this and every future
    -- lookup resolves. Replaces the one-off audit_20260523 sets backfill.
    UPDATE sets s
    SET set_id_onchain = p_set_id_onchain, updated_at = now()
    FROM (
      SELECT split_part(external_id, ':', 1) AS set_uuid
      FROM editions
      WHERE collection_id = v_collection_id
        AND set_id_onchain = p_set_id_onchain
        AND length(split_part(external_id, ':', 1)) = 36
      LIMIT 1
    ) m
    WHERE s.collection_id = v_collection_id
      AND s.external_id = m.set_uuid
      AND s.set_id_onchain IS NULL
    RETURNING s.id, s.name, s.tier, s.series
      INTO v_set_uuid, v_set_name, v_set_tier, v_set_series;

    IF v_set_uuid IS NULL THEN
      -- Genuinely uncataloged: the GQL catalog has not yet created the set
      -- (and editions) for this set_id_onchain. Caller logs catalog_gap; it
      -- resolves on a later tick once the catalog has run.
      RETURN NULL;
    END IF;
  END IF;

  -- Insert the stub. tier and series come from the parent set; player/team/circulation
  -- left NULL for the downstream backfill-topshot-catalog pipeline to hydrate.
  INSERT INTO public.editions (
    external_id, collection_id, set_id, tier, series, edition_kind,
    set_id_onchain, play_id_onchain, collection, set_name,
    created_at, updated_at
  )
  VALUES (
    p_set_id_onchain::text || ':' || p_play_id_onchain::text,
    v_collection_id, v_set_uuid, v_set_tier, v_set_series, 'LE',
    p_set_id_onchain, p_play_id_onchain, 'nba_top_shot', v_set_name,
    now(), now()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_edition_id;

  -- ON CONFLICT branch (raced with another writer): re-select
  IF v_edition_id IS NULL THEN
    SELECT id INTO v_edition_id
    FROM editions
    WHERE collection_id = v_collection_id
      AND set_id_onchain = p_set_id_onchain
      AND play_id_onchain = p_play_id_onchain
    LIMIT 1;
  END IF;

  RETURN v_edition_id;
END;
$function$;
-- <<< END verbatim ensure_topshot_edition_stub <<<

-- v_collection_id inside the fn is hardcoded to the Top Shot UUID; fixtures use it.
--   TS = 95f28a17-224a-4025-96ad-adf8a4c63bfd

-- ── (1) FAST PATH: an existing edition is returned, no new row ──────────────
INSERT INTO editions (external_id, collection_id, set_id_onchain, play_id_onchain, tier, series, collection)
VALUES ('100:5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 100, 5, 'RARE', 4, 'nba_top_shot');
SELECT _assert_eq(
  (ensure_topshot_edition_stub(100, 5))::text,
  (SELECT id::text FROM editions WHERE external_id='100:5'),
  'fast path returns the existing edition id');
SELECT _assert_eq((SELECT count(*)::text FROM editions WHERE set_id_onchain=100), '1', 'fast path inserts nothing');

-- ── (2) DIRECT SET: parent set carries set_id_onchain → stub inherits it ────
INSERT INTO sets (external_id, collection_id, name, tier, series, set_id_onchain)
VALUES ('set-uuid-200', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Base Set 200', 'LEGENDARY', 6, 200);
SELECT _assert((ensure_topshot_edition_stub(200, 7)) IS NOT NULL, 'direct-set path returns a new edition id');
SELECT _assert_eq((SELECT external_id FROM editions WHERE set_id_onchain=200 AND play_id_onchain=7), '200:7', 'stub external_id is set:play');
SELECT _assert_eq((SELECT tier::text FROM editions WHERE external_id='200:7'), 'LEGENDARY', 'stub inherits parent set tier');
SELECT _assert_eq((SELECT series::text FROM editions WHERE external_id='200:7'), '6', 'stub inherits parent set series');
SELECT _assert_eq((SELECT set_name FROM editions WHERE external_id='200:7'), 'Base Set 200', 'stub inherits parent set name');
SELECT _assert_eq((SELECT edition_kind::text FROM editions WHERE external_id='200:7'), 'LE', 'stub edition_kind is LE');

-- ── (3) SELF-HEAL BRIDGE: set exists only by UUID (set_id_onchain NULL) ─────
-- Parent set 300 is UUID-keyed with a NULL set_id_onchain; a sibling edition
-- carries the UUID prefix + set_id_onchain=300. ensure() must backfill the set.
INSERT INTO sets (external_id, collection_id, name, tier, series, set_id_onchain)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Healed Set', 'COMMON', 7, NULL);
INSERT INTO editions (external_id, collection_id, set_id_onchain, play_id_onchain, tier, series, collection)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc:9', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 300, 9, 'COMMON', 7, 'nba_top_shot');
SELECT _assert((ensure_topshot_edition_stub(300, 11)) IS NOT NULL, 'self-heal path returns a new edition id');
SELECT _assert_eq((SELECT set_id_onchain::text FROM sets WHERE external_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
  '300', 'self-heal backfills set_id_onchain onto the UUID-keyed set');
SELECT _assert_eq((SELECT count(*)::text FROM editions WHERE external_id='300:11'), '1', 'self-heal inserts the stub');
SELECT _assert_eq((SELECT tier::text FROM editions WHERE external_id='300:11'), 'COMMON', 'healed stub inherits set tier');

-- ── (4) CATALOG GAP: no set, no sibling edition → NULL, nothing inserted ────
SELECT _assert((ensure_topshot_edition_stub(999, 3)) IS NULL, 'uncataloged set returns NULL');
SELECT _assert_eq((SELECT count(*)::text FROM editions WHERE set_id_onchain=999), '0', 'catalog gap inserts nothing');

-- ── (5) IDEMPOTENT: a repeat call fast-paths to the same id ─────────────────
SELECT _assert_eq((ensure_topshot_edition_stub(200, 7))::text, (SELECT id::text FROM editions WHERE external_id='200:7'),
  'repeat call returns the same stub id (fast path)');
SELECT _assert_eq((SELECT count(*)::text FROM editions WHERE external_id='200:7'), '1', 'repeat call inserts no duplicate');

SELECT '✓ ensure_topshot_edition_stub invariants pass' AS result;
ROLLBACK;
