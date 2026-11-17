-- DB invariant: public.fmv_snapshots_block_stale_ingest_algo — the BEFORE INSERT
-- guard on fmv_snapshots that silently DROPS (RETURN NULL) any row written by the
-- legacy `1.1.0*` ingest writer, so it can never clobber fmv-recalc's canonical FMV.
--
-- Why this pin is load-bearing on its PASS-THROUGH half, not its block half:
-- the guard's failure mode is silent by construction. A widened predicate does not
-- error and does not leave a row behind — it just makes writes evaporate. Every
-- external signal stays green: the route logs ok=true, pipeline_runs records a
-- successful tick, and rows_written counts what was HANDED to the insert, not what
-- landed. Platform-wide FMV would simply stop updating with nothing to see. That is
-- the exact "green pipeline blind to its own work" class this repo keeps hitting,
-- so the assertions below spend most of their weight proving the LIVE algo versions
-- still get through.
--
-- The discriminating case is '1.10.0'. `LIKE '1.1.0%'` does NOT match it (the 4th
-- character is '0', not '.'), so it passes. A "harmless simplification" of the
-- predicate to `LIKE '1.1%'` would start eating a future 1.10.x/1.11.x writer while
-- every test that only checks '1.1.0' blocked + '1.7.0' passed stays green.
--
-- NOTE: unlike its four sibling guards on this table, this function is deliberately
-- NOT SECURITY DEFINER (prosecdef = false live, verified 2026-08-04). Do not "fix"
-- that — it runs as the inserting role by design.
--
-- The function DDL below is a VERBATIM copy of the committed migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-in: only the columns the guard reads or that we assert are untouched.
CREATE TABLE fmv_snapshots (
  edition_id uuid,
  fmv_usd numeric,
  confidence text,
  algo_version text);

-- >>> BEGIN verbatim fmv_snapshots_block_stale_ingest_algo (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_block_stale_ingest_algo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.algo_version LIKE '1.1.0%' THEN
    RETURN NULL;  -- silently skip — fmv-recalc owns canonical FMV
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim fmv_snapshots_block_stale_ingest_algo <<<

CREATE TRIGGER trg_block_stale_ingest_algo BEFORE INSERT ON fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION fmv_snapshots_block_stale_ingest_algo();

-- ── The legacy 1.1.0 writer IS dropped ──────────────────────────────────────────
-- Bare, suffixed and dotted forms all sit under the '1.1.0%' prefix.
INSERT INTO fmv_snapshots VALUES
  ('11111111-1111-1111-1111-111111111101', 100, 'HIGH',   '1.1.0'),
  ('11111111-1111-1111-1111-111111111102', 200, 'MEDIUM', '1.1.0-ingest'),
  ('11111111-1111-1111-1111-111111111103', 300, 'LOW',    '1.1.0.3'),
  ('11111111-1111-1111-1111-111111111104', 400, 'HIGH',   '1.1.09');

SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots), '0',
  'every 1.1.0* row must be dropped — the legacy ingest writer never reaches the table');

-- ── The LIVE writers all get through (the over-reach guard) ─────────────────────
-- These are the real algo_version values in prod: fmv-recalc's 1.7.0 family, the
-- cold-tail drainer, the Pinnacle render engine, and the ask-only path. If a
-- predicate change swallowed ANY of these, FMV would silently stop updating for
-- that whole writer with no error anywhere.
INSERT INTO fmv_snapshots VALUES
  ('22222222-2222-2222-2222-222222222201', 10, 'HIGH',      '1.7.0'),
  ('22222222-2222-2222-2222-222222222202', 20, 'MEDIUM',    '1.7.0-ask'),
  ('22222222-2222-2222-2222-222222222203', 30, 'SALES_ONLY','cold-tail-1.0'),
  ('22222222-2222-2222-2222-222222222204', 40, 'HIGH',      'pinnacle-2.0.0-render'),
  ('22222222-2222-2222-2222-222222222205', 50, 'LOW',       '1.5.0'),
  ('22222222-2222-2222-2222-222222222206', 60, 'MEDIUM',    '1.2.0');

SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots), '6',
  'every live (non-1.1.0) writer must pass through untouched');

-- The guard is a gate, not a mutator: it must never rewrite a passing row.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || confidence || '|' || algo_version
     FROM fmv_snapshots WHERE edition_id = '22222222-2222-2222-2222-222222222201'),
  '10|HIGH|1.7.0', 'a passing row must land byte-for-byte as submitted');

-- ── The discriminating case: 1.10.x is NOT 1.1.0 ────────────────────────────────
-- `LIKE '1.1.0%'` compares position 4 against '0', so '1.10.0' does not match.
-- A loosened `LIKE '1.1%'` would silently start dropping the 1.10/1.11 series —
-- exactly the widening this pin exists to catch.
INSERT INTO fmv_snapshots VALUES
  ('33333333-3333-3333-3333-333333333301', 70, 'HIGH', '1.10.0'),
  ('33333333-3333-3333-3333-333333333302', 80, 'HIGH', '1.11.0'),
  ('33333333-3333-3333-3333-333333333303', 90, 'HIGH', '1.1');

SELECT _assert_eq(
  (SELECT string_agg(algo_version, ',' ORDER BY algo_version) FROM fmv_snapshots
     WHERE edition_id::text LIKE '33333333%'),
  '1.1,1.10.0,1.11.0',
  '1.10.x / 1.11.x / bare 1.1 are NOT the 1.1.0 writer and must pass through');

-- ── NULL algo_version fails OPEN ────────────────────────────────────────────────
-- NULL LIKE '1.1.0%' is NULL, and IF NULL is not TRUE, so the row passes. "We do
-- not know which writer produced this" is not evidence it is the legacy one, and
-- silently dropping unknown-provenance rows would be the worst of both failures.
INSERT INTO fmv_snapshots VALUES
  ('44444444-4444-4444-4444-444444444401', 5, 'NO_DATA', NULL);
SELECT _assert_eq(
  (SELECT count(*)::text FROM fmv_snapshots WHERE algo_version IS NULL), '1',
  'a NULL algo_version must fail open and land, never be dropped as legacy');

-- 10 of the 14 submitted rows survived: 4 blocked, 10 through.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots), '10',
  'exactly the four 1.1.0* rows were dropped out of 14 submitted');

SELECT '✓ fmv_snapshots_block_stale_ingest_algo invariants pass' AS result;
ROLLBACK;
