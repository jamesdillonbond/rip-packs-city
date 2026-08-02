-- DB invariant: public.update_topshot_sale_serial(text, integer) → integer — the
-- Top Shot on-chain serial-enrichment writer. Fills serial_number ONLY on
-- Top Shot (collection 95f28a17-…) source='onchain' rows whose serial is unknown
-- (NULL or 0), with a positive integer, idempotently, stamping ingested_at. A
-- non-positive serial RAISES (rejected loudly, never silently mis-written); a
-- resolved serial or a non-TS/non-onchain row is left alone. A regression here
-- corrupts serial-keyed FMV/premium math or leaks writes across collections.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802182000_audit_20260802_snapshot_serial_write_guards.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE sales (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid,
  source        text,
  nft_id        text,
  serial_number integer,
  ingested_at   timestamptz
);

-- >>> BEGIN verbatim update_topshot_sale_serial (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.update_topshot_sale_serial(p_nft_id text, p_serial_number integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '5s'
AS $function$
DECLARE
  rows_updated int;
BEGIN
  -- Sanity: serial must be positive integer
  IF p_serial_number IS NULL OR p_serial_number <= 0 THEN
    RAISE EXCEPTION 'update_topshot_sale_serial: serial_number must be > 0, got %', p_serial_number;
  END IF;

  UPDATE sales
  SET serial_number = p_serial_number,
      ingested_at   = NOW()  -- mark as freshly enriched
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND source = 'onchain'
    AND nft_id = p_nft_id
    AND (serial_number IS NULL OR serial_number = 0);  -- only update unknown rows, idempotent

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated;
END;
$function$;
-- <<< END verbatim update_topshot_sale_serial <<<

-- Fixtures: a matching TS on-chain unknown-serial row, plus three decoys that
-- share the nft_id but must NOT be touched (wrong collection / wrong source /
-- already resolved).
INSERT INTO sales (collection_id, source, nft_id, serial_number) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'onchain', 'nft-A', NULL),                     -- target (fillable)
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'onchain', 'nft-resolved', 12),                -- already resolved
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'onchain', 'nft-A', NULL),                     -- wrong collection (AllDay)
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'dune',    'nft-A', NULL);                      -- wrong source

-- Non-positive serial RAISES (loud reject, never a silent mis-write).
DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    PERFORM update_topshot_sale_serial('nft-A', 0);
  EXCEPTION WHEN others THEN raised := true;
  END;
  PERFORM _assert(raised, 'serial 0 raises');
  raised := false;
  BEGIN
    PERFORM update_topshot_sale_serial('nft-A', NULL);
  EXCEPTION WHEN others THEN raised := true;
  END;
  PERFORM _assert(raised, 'NULL serial raises');
END $$;

-- Fills exactly the ONE matching TS on-chain unknown-serial row and stamps ingested_at.
SELECT _assert_eq(update_topshot_sale_serial('nft-A', 88)::text, '1', 'exactly one TS onchain unknown row updated');
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND source='onchain' AND nft_id='nft-A'), '88', 'serial written on the target');
SELECT _assert(( (SELECT ingested_at FROM sales WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND source='onchain' AND nft_id='nft-A') IS NOT NULL ), 'ingested_at stamped on enrichment');

-- The decoys are untouched: wrong-collection + wrong-source rows keep NULL serial.
SELECT _assert(( (SELECT serial_number FROM sales WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND nft_id='nft-A') IS NULL ), 'AllDay row not touched (collection filter)');
SELECT _assert(( (SELECT serial_number FROM sales WHERE source='dune' AND nft_id='nft-A') IS NULL ), 'non-onchain row not touched (source filter)');

-- Already-resolved TS row is idempotent: 0 rows updated, serial unchanged.
SELECT _assert_eq(update_topshot_sale_serial('nft-resolved', 99)::text, '0', 'resolved serial not clobbered → 0 rows');
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE nft_id='nft-resolved'), '12', 'resolved serial unchanged');

-- A no-match nft_id updates nothing.
SELECT _assert_eq(update_topshot_sale_serial('nft-missing', 5)::text, '0', 'unknown nft_id → 0 rows');

SELECT '✓ update_topshot_sale_serial invariants pass' AS result;
ROLLBACK;
