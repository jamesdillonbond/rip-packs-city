-- DB invariant: public.stub_editions_from_wmc(text, integer) → json — self-heals
-- the editions catalog by stubbing edition_keys present in wallet_moments_cache
-- but missing from editions. Pins: unknown slug → {"error":"collection not
-- found"} (no write); only genuinely-missing keys for THAT collection are
-- inserted (existing keys, NULL keys, and other-collection keys are skipped); and
-- it is idempotent (a second run inserts nothing).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802192500_audit_20260802_snapshot_stub_editions_from_wmc.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (
  id   uuid PRIMARY KEY,
  slug text
);

CREATE TABLE editions (
  collection_id     uuid,
  external_id       text,
  player_name       text,
  set_name          text,
  tier              text,
  circulation_count integer,
  created_at        timestamptz,
  updated_at        timestamptz,
  UNIQUE (external_id, collection_id)
);

CREATE TABLE wallet_moments_cache (
  collection_id uuid,
  edition_key   text
);

-- >>> BEGIN verbatim stub_editions_from_wmc (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.stub_editions_from_wmc(p_collection_slug text, p_limit integer DEFAULT 1000)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collection_id uuid;
  v_inserted int := 0;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH
  missing_keys AS (
    SELECT DISTINCT wmc.edition_key
    FROM wallet_moments_cache wmc
    WHERE wmc.collection_id = v_collection_id
      AND wmc.edition_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM editions e
        WHERE e.collection_id = v_collection_id
          AND e.external_id = wmc.edition_key
      )
    LIMIT p_limit
  ),
  inserted AS (
    INSERT INTO editions (collection_id, external_id, player_name, set_name, tier, circulation_count, created_at, updated_at)
    SELECT
      v_collection_id,
      mk.edition_key,
      NULL,  -- player to be resolved later
      NULL,  -- set_name to be resolved later
      NULL,  -- tier to be resolved later
      NULL,
      NOW(),
      NOW()
    FROM missing_keys mk
    ON CONFLICT (external_id, collection_id) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  RETURN json_build_object(
    'collection', p_collection_slug,
    'stubs_created', v_inserted
  );
END;
$function$;
-- <<< END verbatim stub_editions_from_wmc <<<

INSERT INTO collections (id, slug) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day');

-- k1 already in editions; k2/k3 missing (k3 twice); NULL key; other-collection key.
INSERT INTO editions (collection_id, external_id) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'k1');
INSERT INTO wallet_moments_cache (collection_id, edition_key) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'k1'),   -- exists → skip
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'k2'),   -- missing → stub
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'k3'),   -- missing → stub
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'k3'),   -- duplicate of k3 → still one stub
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL),   -- NULL key → skip
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'k9');   -- other collection → skip

-- Unknown slug → error, no write.
SELECT _assert_eq(stub_editions_from_wmc('does_not_exist')->>'error', 'collection not found', 'unknown slug → error');
SELECT _assert_eq((SELECT count(*)::text FROM editions), '1', 'error path wrote nothing');

-- Stub exactly the two missing keys for the resolved collection.
SELECT _assert_eq(stub_editions_from_wmc('nba_top_shot')->>'stubs_created', '2', 'stubs k2 + k3 (dup collapsed, k1/NULL/other-collection skipped)');
SELECT _assert(( EXISTS(SELECT 1 FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id='k2') ), 'k2 stub created');
SELECT _assert(( EXISTS(SELECT 1 FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id='k3') ), 'k3 stub created');
SELECT _assert(( NOT EXISTS(SELECT 1 FROM editions WHERE external_id='k9') ), 'other-collection key NOT stubbed under nba_top_shot');

-- Idempotent: a second run stubs nothing more.
SELECT _assert_eq(stub_editions_from_wmc('nba_top_shot')->>'stubs_created', '0', 'second run is idempotent');

SELECT '✓ stub_editions_from_wmc invariants pass' AS result;
ROLLBACK;
