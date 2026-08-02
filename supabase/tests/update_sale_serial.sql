-- DB invariant: public.update_sale_serial(uuid, integer) → boolean — the generic
-- serial-backfill writer. Fills a sale's serial_number ONLY when currently unknown
-- (NULL or legacy 0) and ONLY with a positive integer, idempotently; on a real
-- write it clears any recorded backfill-failure row for that sale. A regression
-- that clobbered an already-resolved serial would silently corrupt every
-- serial-keyed FMV multiplier / special-serial / #1-premium derived from it.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802182000_audit_20260802_snapshot_serial_write_guards.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE sales (
  id            uuid PRIMARY KEY,
  serial_number integer
);

CREATE TABLE sales_serial_backfill_failures (
  sale_id uuid
);

-- >>> BEGIN verbatim update_sale_serial (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.update_sale_serial(p_sale_id uuid, p_serial_number integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '5s'
AS $function$
DECLARE
  v_updated int;
BEGIN
  IF p_serial_number IS NULL OR p_serial_number < 1 THEN
    RETURN false;
  END IF;

  -- Update only if currently unknown (NULL or legacy 0) — idempotent, won't clobber resolved rows
  UPDATE sales
  SET serial_number = p_serial_number
  WHERE id = p_sale_id
    AND (serial_number IS NULL OR serial_number = 0);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- If we updated, also clear any failure row for this sale (success after prior failure)
  IF v_updated > 0 THEN
    DELETE FROM sales_serial_backfill_failures WHERE sale_id = p_sale_id;
  END IF;

  RETURN v_updated > 0;
END;
$function$;
-- <<< END verbatim update_sale_serial <<<

INSERT INTO sales (id, serial_number) VALUES
  ('00000000-0000-0000-0000-000000000001', NULL),  -- unknown (NULL)
  ('00000000-0000-0000-0000-000000000002', 0),     -- unknown (legacy 0)
  ('00000000-0000-0000-0000-000000000003', 25);    -- already resolved

-- Bad serials never write and return false.
SELECT _assert_eq(update_sale_serial('00000000-0000-0000-0000-000000000001', NULL)::text, 'false', 'NULL serial → false');
SELECT _assert_eq(update_sale_serial('00000000-0000-0000-0000-000000000001', 0)::text,    'false', 'serial 0 → false (< 1)');
SELECT _assert_eq(update_sale_serial('00000000-0000-0000-0000-000000000001', -5)::text,   'false', 'negative serial → false');
SELECT _assert(( (SELECT serial_number FROM sales WHERE id='00000000-0000-0000-0000-000000000001') IS NULL ),
  'bad serials left the NULL row untouched');

-- Positive serial fills a NULL row (returns true) and clears its failure row.
INSERT INTO sales_serial_backfill_failures (sale_id) VALUES ('00000000-0000-0000-0000-000000000001');
SELECT _assert_eq(update_sale_serial('00000000-0000-0000-0000-000000000001', 42)::text, 'true', 'NULL → positive writes, returns true');
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE id='00000000-0000-0000-0000-000000000001'), '42', 'serial written');
SELECT _assert(( NOT EXISTS (SELECT 1 FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000001') ),
  'failure row cleared on successful write');

-- Legacy-0 row is also fillable.
SELECT _assert_eq(update_sale_serial('00000000-0000-0000-0000-000000000002', 7)::text, 'true', 'legacy 0 → positive writes');
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE id='00000000-0000-0000-0000-000000000002'), '7', 'legacy 0 overwritten');

-- Already-resolved row is NEVER clobbered (idempotent) and its failure row (if any) stays.
INSERT INTO sales_serial_backfill_failures (sale_id) VALUES ('00000000-0000-0000-0000-000000000003');
SELECT _assert_eq(update_sale_serial('00000000-0000-0000-0000-000000000003', 99)::text, 'false', 'resolved serial not clobbered → false');
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE id='00000000-0000-0000-0000-000000000003'), '25', 'resolved serial unchanged');
SELECT _assert(( EXISTS (SELECT 1 FROM sales_serial_backfill_failures WHERE sale_id='00000000-0000-0000-0000-000000000003') ),
  'no-op call does NOT clear a failure row');

SELECT '✓ update_sale_serial invariants pass' AS result;
ROLLBACK;
