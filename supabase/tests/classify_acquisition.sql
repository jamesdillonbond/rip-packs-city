-- DB invariant: public.classify_acquisition(text,text,text,text,numeric) — the
-- acquisition-method classifier. Its load-bearing property is the "fill-only"
-- honesty gate: it may set a method/confidence/buy_price on a row that is still
-- `unknown`, but must NEVER overwrite an already-classified acquisition (a weaker
-- later scan clobbering a stronger earlier classification would corrupt cost
-- basis and pack-pull attribution).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801160100_audit_20260801_snapshot_classify_acquisition.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE moment_acquisitions (
  nft_id                 text,
  wallet                 text,
  acquisition_method     text,
  acquisition_confidence text,
  buy_price              numeric
);

-- >>> BEGIN verbatim classify_acquisition (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.classify_acquisition(p_nft_id text, p_wallet text, p_method text, p_confidence text DEFAULT 'flow_scan'::text, p_buy_price numeric DEFAULT NULL::numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated int;
BEGIN
  UPDATE moment_acquisitions
  SET acquisition_method = p_method,
      acquisition_confidence = p_confidence,
      buy_price = COALESCE(p_buy_price, buy_price)
  WHERE nft_id = p_nft_id
    AND wallet = p_wallet
    AND acquisition_method = 'unknown';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN json_build_object(
    'updated', v_updated > 0,
    'nft_id', p_nft_id,
    'new_method', p_method,
    'new_confidence', p_confidence
  );
END;
$function$;
-- <<< END verbatim classify_acquisition <<<

-- Case 1: an `unknown` row is filled and the function reports updated=true.
INSERT INTO moment_acquisitions VALUES ('nft1', '0xw', 'unknown', 'seed', NULL);
SELECT _assert(
  (classify_acquisition('nft1', '0xw', 'pack_pull', 'flow_scan', 12.50)->>'updated')::boolean,
  'unknown row → updated=true');
SELECT _assert_eq(
  (SELECT acquisition_method || '|' || acquisition_confidence || '|' || buy_price::text
   FROM moment_acquisitions WHERE nft_id='nft1'),
  'pack_pull|flow_scan|12.50', 'unknown row got method+confidence+price');

-- Case 2: an already-classified row is NOT overwritten (fill-only gate) and the
-- function reports updated=false.
INSERT INTO moment_acquisitions VALUES ('nft2', '0xw', 'purchase', 'dune', 99);
SELECT _assert(
  ((classify_acquisition('nft2', '0xw', 'pack_pull', 'flow_scan', 5)->>'updated')::boolean) IS FALSE,
  'already-classified row → updated=false');
SELECT _assert_eq(
  (SELECT acquisition_method || '|' || acquisition_confidence || '|' || buy_price::text
   FROM moment_acquisitions WHERE nft_id='nft2'),
  'purchase|dune|99', 'classified row untouched');

-- Case 3: a NULL buy_price argument COALESCEs to the existing buy_price (does not
-- null out an existing price on an unknown row that already carried one).
INSERT INTO moment_acquisitions VALUES ('nft3', '0xw', 'unknown', 'seed', 7.25);
SELECT classify_acquisition('nft3', '0xw', 'gift', 'manual', NULL);
SELECT _assert_eq(
  (SELECT buy_price::text FROM moment_acquisitions WHERE nft_id='nft3'),
  '7.25', 'NULL price arg preserves existing buy_price');

-- Case 4: no matching (nft_id, wallet) row → updated=false, nothing written.
SELECT _assert(
  ((classify_acquisition('nope', '0xw', 'pack_pull')->>'updated')::boolean) IS FALSE,
  'no matching row → updated=false');

SELECT '✓ classify_acquisition invariants pass' AS result;
ROLLBACK;
