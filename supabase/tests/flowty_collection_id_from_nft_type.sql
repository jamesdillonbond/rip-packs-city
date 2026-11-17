-- DB invariant: public.flowty_collection_id_from_nft_type — maps an on-chain NFT
-- type string to its collection UUID. Load-bearing for the Flowty listing/offer
-- extractors: a wrong mapping files a listing under the wrong collection (or, on
-- an ELSE→NULL miss, drops it from the mapped set entirely). The five UUIDs are
-- the canonical collection ids (CLAUDE.md "Collection UUIDs"); this pins both the
-- constants and the two easy-to-break branches (UFC has TWO type patterns; an
-- unknown type must resolve to NULL, never a default collection).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260517220000_flowty_extractor_marketplace_offers_and_rpcs.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
-- Pure IMMUTABLE function — no fixtures needed. Runs inside a rolled-back txn.

BEGIN;

-- >>> BEGIN verbatim flowty_collection_id_from_nft_type (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.flowty_collection_id_from_nft_type(p_nft_type text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_nft_type LIKE '%TopShot.NFT' THEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    WHEN p_nft_type LIKE '%AllDay.NFT'  THEN 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    WHEN p_nft_type LIKE '%Golazos.NFT' THEN '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
    WHEN p_nft_type LIKE '%UFC_NFT.NFT' OR p_nft_type LIKE '%UFCStrike%' THEN '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
    WHEN p_nft_type LIKE '%Pinnacle.NFT' THEN '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
    ELSE NULL
  END;
$function$;
-- <<< END verbatim flowty_collection_id_from_nft_type <<<

-- each collection's fully-qualified on-chain type resolves to its canonical UUID
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type('A.0b2a3299cc857e29.TopShot.NFT')::text,
  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'TopShot type → TopShot UUID');
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type('A.e4cf4bdc1751c65d.AllDay.NFT')::text,
  'dee28451-5d62-409e-a1ad-a83f763ac070', 'AllDay type → AllDay UUID');
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type('A.87ca73a41bb50ad5.Golazos.NFT')::text,
  '06248cc4-b85f-47cd-af67-1855d14acd75', 'Golazos type → Golazos UUID');
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type('A.edf9df96c92f4595.Pinnacle.NFT')::text,
  '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'Pinnacle type → Pinnacle UUID');

-- UFC has TWO accepted patterns — both must map to the UFC UUID
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type('A.329feb3ab062d289.UFC_NFT.NFT')::text,
  '9b4824a8-736d-4a96-b450-8dcc0c46b023', 'UFC_NFT.NFT pattern → UFC UUID');
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type('A.329feb3ab062d289.UFCStrike.NFT')::text,
  '9b4824a8-736d-4a96-b450-8dcc0c46b023', 'UFCStrike pattern → UFC UUID');

-- an unmatched / unknown type must be NULL, never a default collection
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type('A.deadbeef.SomethingElse.NFT')::text,
  NULL, 'unknown type → NULL (no default collection)');
-- NULL input coalesces through to NULL
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type(NULL)::text,
  NULL, 'NULL input → NULL');
-- the match is anchored to the SUFFIX: a type that merely CONTAINS TopShot.NFT
-- mid-string but does not end with it must NOT match (LIKE '%TopShot.NFT').
SELECT _assert_eq(
  public.flowty_collection_id_from_nft_type('A.x.TopShot.NFT.Wrapper')::text,
  NULL, 'TopShot.NFT mid-string (not a suffix) → NULL');

SELECT '✓ flowty_collection_id_from_nft_type: all 9 assertions passed' AS result;

ROLLBACK;
