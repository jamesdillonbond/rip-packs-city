-- DB invariant: public.record_serial_backfill_failure(uuid, uuid, text, text, text)
-- — the failure-side companion to the serial-write guards. One failure row per
-- sale, keyed ON CONFLICT (sale_id): a first failure inserts retry_count=1; every
-- repeat INCREMENTS retry_count and refreshes reason/detail/last_failed_at while
-- PRESERVING first_failed_at. A regression that reset either counter corrupts the
-- give-up-after-N-retries accounting the backfill depends on.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802182500_audit_20260802_snapshot_record_serial_backfill_failure.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE sales_serial_backfill_failures (
  sale_id         uuid PRIMARY KEY,
  collection_id   uuid,
  nft_id          text,
  failure_reason  text,
  failure_detail  text,
  retry_count     integer,
  first_failed_at timestamptz,
  last_failed_at  timestamptz
);

-- >>> BEGIN verbatim record_serial_backfill_failure (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.record_serial_backfill_failure(p_sale_id uuid, p_collection_id uuid, p_nft_id text, p_reason text, p_detail text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '3s'
AS $function$
  INSERT INTO sales_serial_backfill_failures (
    sale_id, collection_id, nft_id, failure_reason, failure_detail,
    retry_count, first_failed_at, last_failed_at
  )
  VALUES (
    p_sale_id, p_collection_id, p_nft_id, p_reason, p_detail,
    1, NOW(), NOW()
  )
  ON CONFLICT (sale_id) DO UPDATE
    SET retry_count    = sales_serial_backfill_failures.retry_count + 1,
        failure_reason = EXCLUDED.failure_reason,
        failure_detail = EXCLUDED.failure_detail,
        last_failed_at = NOW();
$function$;
-- <<< END verbatim record_serial_backfill_failure <<<

-- First failure → inserts one row, retry_count 1.
SELECT record_serial_backfill_failure(
  '00000000-0000-0000-0000-000000000001',
  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nft-1', 'no_serial_onchain', 'first detail');
SELECT _assert_eq((SELECT retry_count::text FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000001'), '1', 'first failure → retry_count 1');
SELECT _assert_eq((SELECT failure_reason FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000001'), 'no_serial_onchain', 'reason stored');
SELECT _assert_eq((SELECT count(*)::text FROM sales_serial_backfill_failures), '1', 'one row');

-- Pin first_failed_at into the past so the preserve-vs-refresh split is observable.
UPDATE sales_serial_backfill_failures
   SET first_failed_at = '2020-01-01', last_failed_at = '2020-01-01'
 WHERE sale_id = '00000000-0000-0000-0000-000000000001';

-- Repeat failure → increments retry_count, refreshes reason/detail + last_failed_at,
-- but PRESERVES first_failed_at; still exactly one row.
SELECT record_serial_backfill_failure(
  '00000000-0000-0000-0000-000000000001',
  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nft-1', 'timeout', 'second detail');
SELECT _assert_eq((SELECT retry_count::text FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000001'), '2', 'repeat → retry_count incremented to 2');
SELECT _assert_eq((SELECT failure_reason FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000001'), 'timeout', 'reason refreshed on repeat');
SELECT _assert_eq((SELECT failure_detail FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000001'), 'second detail', 'detail refreshed on repeat');
SELECT _assert_eq((SELECT first_failed_at::date::text FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000001'), '2020-01-01', 'first_failed_at PRESERVED across repeats');
SELECT _assert(( (SELECT last_failed_at FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000001') > '2020-01-02' ), 'last_failed_at refreshed to now');
SELECT _assert_eq((SELECT count(*)::text FROM sales_serial_backfill_failures), '1', 'still one row (upsert, not a duplicate)');

-- A different sale is its own independent row.
SELECT record_serial_backfill_failure(
  '00000000-0000-0000-0000-000000000002',
  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nft-2', 'no_serial_onchain');
SELECT _assert_eq((SELECT retry_count::text FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000002'), '1', 'distinct sale → its own retry_count 1');
SELECT _assert_eq((SELECT count(*)::text FROM sales_serial_backfill_failures), '2', 'two distinct sales → two rows');

SELECT '✓ record_serial_backfill_failure invariants pass' AS result;
ROLLBACK;
