-- DB invariant: public.pinnacle_upsert_nft_map(text, text, text) → json — the
-- Pinnacle nft_id → edition_key + owner map upsert. Pins the honesty invariant
-- owner = COALESCE(EXCLUDED.owner, existing): a NULL-owner refresh must never null
-- out a known owner (which would drop a real holder off ownership surfaces),
-- while a non-NULL owner does update; edition_key always follows the latest call;
-- and edition_exists_in_editions_table reflects presence in pinnacle_editions.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802185000_audit_20260802_snapshot_pinnacle_upsert_nft_map.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE pinnacle_editions (
  id text PRIMARY KEY
);

CREATE TABLE pinnacle_nft_map (
  nft_id      text PRIMARY KEY,
  edition_key text,
  owner       text,
  created_at  timestamptz
);

-- >>> BEGIN verbatim pinnacle_upsert_nft_map (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.pinnacle_upsert_nft_map(p_nft_id text, p_edition_key text, p_owner text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_edition_exists boolean;
BEGIN
  -- Safety: verify edition_key exists in pinnacle_editions before inserting, else backfill_pinnacle_sale_editions() will skip it
  SELECT EXISTS(SELECT 1 FROM pinnacle_editions WHERE id = p_edition_key)
  INTO v_edition_exists;

  INSERT INTO pinnacle_nft_map (nft_id, edition_key, owner, created_at)
  VALUES (p_nft_id, p_edition_key, p_owner, now())
  ON CONFLICT (nft_id) DO UPDATE SET
    edition_key = EXCLUDED.edition_key,
    owner = COALESCE(EXCLUDED.owner, pinnacle_nft_map.owner);

  RETURN json_build_object(
    'nft_id', p_nft_id,
    'edition_key', p_edition_key,
    'edition_exists_in_editions_table', v_edition_exists,
    'backfill_required', true
  );
END;
$function$;
-- <<< END verbatim pinnacle_upsert_nft_map <<<

INSERT INTO pinnacle_editions (id) VALUES ('royalty:base:1');

-- New nft with a known edition_key + owner → inserted; edition_exists = true.
SELECT _assert_eq(
  (pinnacle_upsert_nft_map('nft-1', 'royalty:base:1', '0xownerA')->>'edition_exists_in_editions_table'),
  'true', 'known edition_key → edition_exists true');
SELECT _assert_eq((SELECT owner FROM pinnacle_nft_map WHERE nft_id='nft-1'), '0xownerA', 'new row stores owner');

-- New nft with an edition_key NOT in pinnacle_editions → edition_exists = false.
SELECT _assert_eq(
  (pinnacle_upsert_nft_map('nft-2', 'royalty:missing:9', '0xownerB')->>'edition_exists_in_editions_table'),
  'false', 'unknown edition_key → edition_exists false');

-- HONESTY INVARIANT: a NULL-owner refresh must NOT null out the known owner, but
-- it DOES update edition_key.
SELECT pinnacle_upsert_nft_map('nft-1', 'royalty:base:1-v2', NULL);
SELECT _assert_eq((SELECT owner FROM pinnacle_nft_map WHERE nft_id='nft-1'), '0xownerA', 'NULL-owner refresh preserves the known owner');
SELECT _assert_eq((SELECT edition_key FROM pinnacle_nft_map WHERE nft_id='nft-1'), 'royalty:base:1-v2', 'edition_key still follows the latest call');

-- A non-NULL owner DOES update (real ownership transfer).
SELECT pinnacle_upsert_nft_map('nft-1', 'royalty:base:1-v2', '0xownerC');
SELECT _assert_eq((SELECT owner FROM pinnacle_nft_map WHERE nft_id='nft-1'), '0xownerC', 'non-NULL owner updates on transfer');

-- Still exactly one row per nft_id (upsert, not duplicate).
SELECT _assert_eq((SELECT count(*)::text FROM pinnacle_nft_map WHERE nft_id='nft-1'), '1', 'one row per nft_id');

SELECT '✓ pinnacle_upsert_nft_map invariants pass' AS result;
ROLLBACK;
