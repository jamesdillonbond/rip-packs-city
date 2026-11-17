-- DB invariant: public.fmv_snapshots_block_phantoms — the BEFORE INSERT guard on
-- fmv_snapshots that stops an impossible high FMV (> $10k) from landing unless it
-- is backed by HIGH confidence AND >= 3 recent sales, auditing every blocked
-- attempt to fmv_phantom_attempts. This is the guard that keeps a phantom grail
-- valuation off the public surface. The function DDL below is a VERBATIM copy of
-- the committed migration
-- (supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins for the three tables the guard touches.
CREATE TABLE editions (id uuid PRIMARY KEY, collection_id uuid);
CREATE TABLE fmv_phantom_attempts (
  id bigserial PRIMARY KEY, edition_id uuid, collection_id uuid,
  attempted_fmv numeric, attempted_wap numeric, attempted_floor numeric,
  confidence text, sales_count_30d int, source_route text, created_at timestamptz DEFAULT now());
CREATE TABLE fmv_snapshots (
  edition_id uuid, fmv_usd numeric, asp_usd numeric, floor_price_usd numeric,
  confidence text, sales_count_30d int);

-- >>> BEGIN verbatim fmv_snapshots_block_phantoms (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_block_phantoms()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_collection_id uuid;
BEGIN
  IF NEW.fmv_usd > 10000
     AND NOT (NEW.confidence::text = 'HIGH' AND COALESCE(NEW.sales_count_30d, 0) >= 3) THEN
    -- Look up collection_id from edition for the audit row
    SELECT collection_id INTO v_collection_id FROM editions WHERE id = NEW.edition_id;

    -- Audit-log what would have been written
    INSERT INTO fmv_phantom_attempts (
      edition_id, collection_id, attempted_fmv, attempted_wap, attempted_floor,
      confidence, sales_count_30d, source_route
    )
    VALUES (
      NEW.edition_id, v_collection_id, NEW.fmv_usd, NEW.asp_usd, NEW.floor_price_usd,
      NEW.confidence::text, NEW.sales_count_30d, 'trigger_intercept'
    );

    -- Null the phantom values, preserving the audit row
    NEW.fmv_usd := NULL;
    NEW.asp_usd := NULL;
    NEW.floor_price_usd := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim fmv_snapshots_block_phantoms <<<

CREATE TRIGGER trg_block_phantoms BEFORE INSERT ON fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION fmv_snapshots_block_phantoms();

INSERT INTO editions VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');

-- Case 1 — phantom: > $10k with LOW confidence → fmv/asp/floor nulled, audited.
INSERT INTO fmv_snapshots VALUES ('11111111-1111-1111-1111-111111111111', 42000, 40000, 39000, 'LOW', 0);
SELECT _assert(
  (SELECT fmv_usd IS NULL AND asp_usd IS NULL AND floor_price_usd IS NULL
     FROM fmv_snapshots WHERE confidence = 'LOW' AND sales_count_30d = 0),
  'phantom high FMV with LOW confidence must be nulled');
SELECT _assert_eq(
  (SELECT count(*)::text FROM fmv_phantom_attempts WHERE attempted_fmv = 42000 AND source_route = 'trigger_intercept'),
  '1', 'phantom attempt must be audited with the original values + collection_id');
SELECT _assert_eq(
  (SELECT collection_id::text FROM fmv_phantom_attempts WHERE attempted_fmv = 42000),
  '22222222-2222-2222-2222-222222222222', 'audit row carries the edition collection_id');

-- Case 2 — legitimate: > $10k WITH HIGH confidence AND >= 3 sales → allowed through.
INSERT INTO fmv_snapshots VALUES ('11111111-1111-1111-1111-111111111111', 42000, 40000, 39000, 'HIGH', 3);
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM fmv_snapshots WHERE confidence = 'HIGH'),
  '42000', 'HIGH + >=3 sales high FMV must pass untouched');

-- Case 3 — HIGH but only 2 sales → still a phantom (both conditions required).
INSERT INTO fmv_snapshots VALUES ('11111111-1111-1111-1111-111111111111', 50000, NULL, NULL, 'HIGH', 2);
SELECT _assert(
  (SELECT fmv_usd IS NULL FROM fmv_snapshots WHERE sales_count_30d = 2),
  'HIGH confidence with < 3 sales must still be blocked');

-- Case 4 — ordinary sub-$10k FMV → untouched regardless of confidence.
INSERT INTO fmv_snapshots VALUES ('11111111-1111-1111-1111-111111111111', 500, 480, 470, 'LOW', 0);
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM fmv_snapshots WHERE fmv_usd = 500),
  '500', 'a normal low FMV is never touched');

-- Exactly one phantom was audited across all four inserts.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_phantom_attempts), '2', 'exactly the two phantoms are audited');

SELECT '✓ fmv_snapshots_block_phantoms invariants pass' AS result;
ROLLBACK;
