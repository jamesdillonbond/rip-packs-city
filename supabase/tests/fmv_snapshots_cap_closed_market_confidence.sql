-- DB invariant: public.fmv_snapshots_cap_closed_market_confidence — the BEFORE INSERT
-- guard on fmv_snapshots that caps confidence at STALE for any collection carrying
-- collections.market_closed_at. This is what stops a closed market (UFC Strike, closed
-- 2026-05-13) from publishing a confident price: before it existed, 14 UFC editions sat
-- at HIGH/MEDIUM with 1-day-old snapshots off sales 387-430 days old, because
-- fmv-recalc's Step-6 carry-forward re-stamped them daily. One trigger covers all 8
-- fmv-recalc insert paths plus fmv-backfill plus any future writer, which is the whole
-- reason it lives in the DB rather than in each caller.
--
-- The function DDL below is a VERBATIM copy of the committed migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins for the two tables the guard touches.
CREATE TABLE collections (
  id uuid PRIMARY KEY, slug text, market_closed_at timestamptz);
CREATE TABLE fmv_snapshots (
  edition_id uuid, collection_id uuid, fmv_usd numeric, confidence text);

-- >>> BEGIN verbatim fmv_snapshots_cap_closed_market_confidence (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_closed_market_confidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.confidence IN ('HIGH','MEDIUM','LOW','SALES_ONLY','ASK_ONLY')
     AND EXISTS (
       SELECT 1 FROM public.collections c
       WHERE c.id = NEW.collection_id
         AND c.market_closed_at IS NOT NULL
     )
  THEN
    NEW.confidence := 'STALE';
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim fmv_snapshots_cap_closed_market_confidence <<<

CREATE TRIGGER trg_cap_closed_market BEFORE INSERT ON fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION fmv_snapshots_cap_closed_market_confidence();

-- 'CLOSED' = a market with market_closed_at set (UFC Strike's real shape).
-- 'OPEN'   = market_closed_at NULL (every other collection).
INSERT INTO collections VALUES
  ('c1050000-0000-0000-0000-000000000001', 'ufc_strike',   '2026-05-13'),
  ('09e00000-0000-0000-0000-000000000002', 'nba_top_shot', NULL);

-- ── CLOSED market: every confident label is capped ──────────────────────────────
-- All five listed in the guard, so a future writer using any of them is covered.
INSERT INTO fmv_snapshots VALUES
  ('11111111-1111-1111-1111-111111111101', 'c1050000-0000-0000-0000-000000000001', 313.43, 'HIGH'),
  ('11111111-1111-1111-1111-111111111102', 'c1050000-0000-0000-0000-000000000001', 172.09, 'MEDIUM'),
  ('11111111-1111-1111-1111-111111111103', 'c1050000-0000-0000-0000-000000000001',  55.79, 'LOW'),
  ('11111111-1111-1111-1111-111111111104', 'c1050000-0000-0000-0000-000000000001',  42.78, 'SALES_ONLY'),
  ('11111111-1111-1111-1111-111111111105', 'c1050000-0000-0000-0000-000000000001',   1.10, 'ASK_ONLY');

SELECT _assert_eq(
  (SELECT count(*)::text FROM fmv_snapshots
    WHERE collection_id = 'c1050000-0000-0000-0000-000000000001' AND confidence <> 'STALE'),
  '0', 'every confident label on a closed market must be capped to STALE');

-- The FMV value itself is untouched — this guard relabels, it does not reprice.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = '11111111-1111-1111-1111-111111111101'),
  '313.43', 'the guard must relabel confidence only, never alter fmv_usd');

-- ── CLOSED market: labels that are already non-confident pass through unchanged ──
-- NO_DATA is deliberately NOT in the guard's list; over-reaching here would erase the
-- distinction between "we have no data" and "the market is closed".
INSERT INTO fmv_snapshots VALUES
  ('11111111-1111-1111-1111-111111111106', 'c1050000-0000-0000-0000-000000000001', NULL, 'NO_DATA'),
  ('11111111-1111-1111-1111-111111111107', 'c1050000-0000-0000-0000-000000000001', 9.19, 'STALE');

SELECT _assert_eq(
  (SELECT confidence FROM fmv_snapshots WHERE edition_id = '11111111-1111-1111-1111-111111111106'),
  'NO_DATA', 'NO_DATA must survive a closed market unchanged');
SELECT _assert_eq(
  (SELECT confidence FROM fmv_snapshots WHERE edition_id = '11111111-1111-1111-1111-111111111107'),
  'STALE', 'STALE is idempotent under the guard');

-- ── OPEN market: nothing is touched ─────────────────────────────────────────────
-- The negative case that matters most. The 2026-08-04 rollout had to leave Top Shot,
-- All Day, Candy and Golazos byte-unchanged; a guard that over-reaches here would
-- silently STALE the entire platform.
INSERT INTO fmv_snapshots VALUES
  ('22222222-2222-2222-2222-222222222201', '09e00000-0000-0000-0000-000000000002', 1000, 'HIGH'),
  ('22222222-2222-2222-2222-222222222202', '09e00000-0000-0000-0000-000000000002',  500, 'MEDIUM'),
  ('22222222-2222-2222-2222-222222222203', '09e00000-0000-0000-0000-000000000002',  250, 'ASK_ONLY');

SELECT _assert_eq(
  (SELECT count(*)::text FROM fmv_snapshots
    WHERE collection_id = '09e00000-0000-0000-0000-000000000002' AND confidence = 'STALE'),
  '0', 'an OPEN market must never be relabelled by this guard');
SELECT _assert_eq(
  (SELECT confidence FROM fmv_snapshots WHERE edition_id = '22222222-2222-2222-2222-222222222201'),
  'HIGH', 'HIGH on an open market passes through untouched');

-- ── Unknown collection: fails OPEN, not closed ──────────────────────────────────
-- EXISTS is false for a collection_id with no matching row, so the label survives.
-- Pinned deliberately: the alternative (defaulting to STALE on a lookup miss) would
-- mass-relabel on any FK gap, which is a far worse failure than leaving it alone.
INSERT INTO fmv_snapshots VALUES
  ('33333333-3333-3333-3333-333333333301', 'deadbeef-0000-0000-0000-000000000000', 77, 'HIGH');
SELECT _assert_eq(
  (SELECT confidence FROM fmv_snapshots WHERE edition_id = '33333333-3333-3333-3333-333333333301'),
  'HIGH', 'an unmatched collection_id must fail open, never default to STALE');

-- NULL collection_id behaves the same way.
INSERT INTO fmv_snapshots VALUES
  ('33333333-3333-3333-3333-333333333302', NULL, 88, 'MEDIUM');
SELECT _assert_eq(
  (SELECT confidence FROM fmv_snapshots WHERE edition_id = '33333333-3333-3333-3333-333333333302'),
  'MEDIUM', 'a NULL collection_id must fail open');

-- Exactly the five closed-market confident rows were capped, out of 12 inserted.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots WHERE confidence = 'STALE'), '6',
  'exactly the 5 capped rows plus the 1 already-STALE row read STALE');
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots), '12', 'no row was dropped by the guard');

SELECT '✓ fmv_snapshots_cap_closed_market_confidence invariants pass' AS result;
ROLLBACK;
