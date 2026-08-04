-- DB invariant: public.fmv_snapshots_zero_stale_sales_count — the BEFORE INSERT
-- guard on fmv_snapshots that zeroes sales_count_30d when the row's OWN
-- days_since_sale exceeds 30. Sibling of fmv_snapshots_cap_closed_market_confidence
-- (that one caps the confidence LABEL; this one fixes the sales COUNT).
--
-- Why it exists: fmv_snapshots carries both sales_count_30d and days_since_sale,
-- so one row can contradict itself. fmv-recalc Step 6 carries a prior row forward,
-- re-stamping sales_count_30d unchanged while days_since_sale keeps climbing —
-- producing a public moment page reading "7 sales / 30d" beside a last sale 524
-- days ago, under a "Flow trading frozen since May 2026" banner. 58 latest-per-edition
-- rows were self-contradictory when this shipped (UFC 18 systemic, plus a Top Shot
-- edition claiming 75 sales/30d on a last sale over 30 days old).
--
-- The dangerous failure mode is OVER-reach, not under-reach: this trigger fires on
-- EVERY fmv_snapshots insert platform-wide, so a widened predicate would silently
-- zero the sales counts of thousands of legitimately-trading editions. The
-- pass-through cases below are therefore the load-bearing half of this pin.
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
  days_since_sale integer,
  sales_count_30d integer);

-- >>> BEGIN verbatim fmv_snapshots_zero_stale_sales_count (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_zero_stale_sales_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A row cannot honestly report 30-day sales when its own last sale is older
  -- than 30 days. Zero only that self-contradiction; never touch fmv_usd,
  -- days_since_sale, confidence, or a row with a genuine recent sale.
  IF COALESCE(NEW.days_since_sale, 0) > 30 AND COALESCE(NEW.sales_count_30d, 0) > 0 THEN
    NEW.sales_count_30d := 0;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim fmv_snapshots_zero_stale_sales_count <<<

CREATE TRIGGER trg_zero_stale_sales_count BEFORE INSERT ON fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION fmv_snapshots_zero_stale_sales_count();

-- ── The self-contradiction IS zeroed ────────────────────────────────────────────
-- 387d is the real Dustin Poirier UFC row that motivated the fix; 524d was the
-- measured worst case; 31d is the first value past the boundary.
INSERT INTO fmv_snapshots VALUES
  ('11111111-1111-1111-1111-111111111101', 313.43, 'STALE',  387, 7),
  ('11111111-1111-1111-1111-111111111102',   9.19, 'STALE',  524, 3),
  ('11111111-1111-1111-1111-111111111103',  50.00, 'MEDIUM',  31, 1),
  ('11111111-1111-1111-1111-111111111104',  12.00, 'MEDIUM',  45, 75);

SELECT _assert_eq(
  (SELECT count(*)::text FROM fmv_snapshots
    WHERE days_since_sale > 30 AND sales_count_30d <> 0),
  '0', 'a row whose own last sale is >30d old must never report 30-day sales');

-- The guard relabels the COUNT only — value, confidence and the age itself survive.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || confidence || '|' || days_since_sale::text
     FROM fmv_snapshots WHERE edition_id = '11111111-1111-1111-1111-111111111101'),
  '313.43|STALE|387', 'the guard must zero sales_count_30d only, never fmv/confidence/days_since_sale');

-- ── Genuine recent sales are UNTOUCHED (the over-reach guard) ───────────────────
-- 30 is the boundary and the predicate is strictly `> 30`, so 30 must pass through.
-- Getting this wrong would zero the counts of every actively-traded edition.
INSERT INTO fmv_snapshots VALUES
  ('22222222-2222-2222-2222-222222222201', 1000, 'HIGH',    0, 42),
  ('22222222-2222-2222-2222-222222222202',  500, 'HIGH',    1, 17),
  ('22222222-2222-2222-2222-222222222203',  250, 'MEDIUM', 29,  4),
  ('22222222-2222-2222-2222-222222222204',  125, 'MEDIUM', 30,  9);

SELECT _assert_eq(
  (SELECT string_agg(sales_count_30d::text, ',' ORDER BY days_since_sale)
     FROM fmv_snapshots WHERE edition_id::text LIKE '22222222%'),
  '42,17,4,9', 'a row with a sale inside 30d keeps its count, and 30 is INSIDE the window');

-- ── NULL handling: both COALESCE arms must fail OPEN ────────────────────────────
-- days_since_sale NULL means "we do not know how old the last sale is" — that is
-- not evidence of staleness, so the count must survive. COALESCE(NULL,0)=0, not >30.
INSERT INTO fmv_snapshots VALUES
  ('33333333-3333-3333-3333-333333333301', 77, 'LOW', NULL, 12);
SELECT _assert_eq(
  (SELECT sales_count_30d::text FROM fmv_snapshots WHERE edition_id = '33333333-3333-3333-3333-333333333301'),
  '12', 'a NULL days_since_sale must fail open and keep the count, never zero it');

-- sales_count_30d NULL on a stale row must stay NULL — the guard must not
-- manufacture a 0 where the pipeline recorded "unknown".
INSERT INTO fmv_snapshots VALUES
  ('33333333-3333-3333-3333-333333333302', 88, 'STALE', 400, NULL);
SELECT _assert_eq(
  (SELECT COALESCE(sales_count_30d::text, 'NULL') FROM fmv_snapshots
     WHERE edition_id = '33333333-3333-3333-3333-333333333302'),
  'NULL', 'a NULL sales_count_30d must stay NULL, never be rewritten to 0');

-- Already-zero on a stale row is idempotent (no spurious rewrite).
INSERT INTO fmv_snapshots VALUES
  ('33333333-3333-3333-3333-333333333303', 99, 'STALE', 400, 0);
SELECT _assert_eq(
  (SELECT sales_count_30d::text FROM fmv_snapshots WHERE edition_id = '33333333-3333-3333-3333-333333333303'),
  '0', 'an already-zero count on a stale row is idempotent under the guard');

-- Exactly the 4 self-contradictory rows were zeroed, out of 11 inserted.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots WHERE sales_count_30d = 0), '5',
  'exactly the 4 zeroed rows plus the 1 already-zero row read 0');
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots), '11', 'no row was dropped by the guard');

SELECT '✓ fmv_snapshots_zero_stale_sales_count invariants pass' AS result;
ROLLBACK;
