-- DB invariant: public.panini_fmv_snapshots_withhold_over_cap — the BEFORE INSERT/UPDATE guard on
-- panini_fmv_snapshots that withholds any FMV above $10,000, the outcome fmv_snapshots_block_phantoms already
-- enforces on the published FMV (a Panini row reaches fmv_snapshots with no sales count). Added 2026-11-04:
-- the twin table fed the public Panini boards a $500,000 ask-only FMV and a "30 % off" $44,000 Ronaldo deal.
-- Claims:
--   R1. an insert above $10,000 lands with fmv_usd NULL (every confidence, HIGH included);
--   R2. exactly $10,000 and anything below pass unchanged; a NULL stays NULL;
--   R3. an UPDATE that raises fmv_usd above the cap is withheld too; the other columns are untouched.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261105000529_audit_20261104_panini_fmv_snapshots_withhold_over_cap.sql); __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE panini_fmv_snapshots (id bigint, edition_id text, fmv_usd numeric, confidence text, algo_version text);

-- >>> BEGIN verbatim panini_fmv_snapshots_withhold_over_cap (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.panini_fmv_snapshots_withhold_over_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Same ceiling as fmv_snapshots_block_phantoms; a Panini row reaches fmv_snapshots with no sales count,
  -- so there every value above it is withheld. One number per edition across the site.
  IF NEW.fmv_usd > 10000 THEN
    NEW.fmv_usd := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim <<<

CREATE TRIGGER panini_fmv_snapshots_withhold_over_cap_trg
  BEFORE INSERT OR UPDATE OF fmv_usd ON panini_fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.panini_fmv_snapshots_withhold_over_cap();

INSERT INTO panini_fmv_snapshots VALUES
  (1, 'e1', 500000, 'ASK_ONLY', 'panini-1.4.0'),
  (2, 'e2', 62509,  'HIGH',     'panini-1.4.0'),
  (3, 'e3', 10000,  'LOW',      'panini-1.4.0'),
  (4, 'e4', 9999.99,'MEDIUM',   'panini-1.4.0'),
  (5, 'e5', NULL,   'ASK_ONLY', 'panini-1.4.0');

SELECT _assert((SELECT fmv_usd IS NULL FROM panini_fmv_snapshots WHERE id = 1), 'R1: a $500,000 ASK_ONLY insert is withheld');
SELECT _assert((SELECT fmv_usd IS NULL FROM panini_fmv_snapshots WHERE id = 2), 'R1: HIGH is not exempt (the published FMV withholds it too)');
SELECT _assert_eq((SELECT fmv_usd::text FROM panini_fmv_snapshots WHERE id = 3), '10000', 'R2: exactly the cap passes');
SELECT _assert_eq((SELECT fmv_usd::text FROM panini_fmv_snapshots WHERE id = 4), '9999.99', 'R2: below the cap passes');
SELECT _assert((SELECT fmv_usd IS NULL FROM panini_fmv_snapshots WHERE id = 5), 'R2: NULL stays NULL');

UPDATE panini_fmv_snapshots SET fmv_usd = 25000 WHERE id = 4;
SELECT _assert_eq((SELECT coalesce(fmv_usd::text, 'null') || '/' || confidence || '/' || algo_version FROM panini_fmv_snapshots WHERE id = 4),
  'null/MEDIUM/panini-1.4.0', 'R3: an update above the cap is withheld; other columns untouched');

SELECT '✓ panini_fmv_snapshots_withhold_over_cap: all assertions passed' AS result;

ROLLBACK;
