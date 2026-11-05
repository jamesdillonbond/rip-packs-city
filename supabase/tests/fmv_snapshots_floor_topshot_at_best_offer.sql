-- DB invariant: public.fmv_snapshots_floor_topshot_at_best_offer — the BEFORE INSERT guard (2026-11-04) that raises a
-- Top Shot fmv_usd to the best OPEN, unexpired edition-level offer when that offer is above it and at most 3x it,
-- marked algo_version …_bidfloor. Backtested on clean post-10-23 sales: moved rows 59.6 -> 73.1 % within +/-25
-- (offer <= 1.5x the price), better in every confidence tier and for listing purchases and offer fills alike.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (20261105033000_audit_20261104_topshot_fmv_floor_at_best_offer);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins: only the columns the guard reads.
CREATE TABLE offers (
  collection_id uuid, edition_id uuid, offer_amount_usd numeric, status text, offer_type text, expires_at timestamptz);
CREATE TABLE fmv_snapshots (
  edition_id uuid, collection_id uuid, fmv_usd numeric, confidence text, algo_version text);

-- >>> BEGIN verbatim fmv_snapshots_floor_topshot_at_best_offer (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_floor_topshot_at_best_offer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_bid numeric;
BEGIN
  IF NEW.collection_id = c_topshot
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.fmv_usd > 0
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT max(o.offer_amount_usd)
      INTO v_bid
      FROM public.offers o
     WHERE o.collection_id = c_topshot
       AND o.edition_id = NEW.edition_id
       AND o.status = 'open'
       AND o.offer_type = 'edition'
       AND (o.expires_at IS NULL OR o.expires_at > now());
    IF v_bid IS NOT NULL AND v_bid > NEW.fmv_usd AND v_bid <= 3 * NEW.fmv_usd THEN
      NEW.fmv_usd := round(v_bid, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_bidfloor';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim fmv_snapshots_floor_topshot_at_best_offer <<<

CREATE TRIGGER fmv_snapshots_floor_topshot_at_best_offer_trg
  BEFORE INSERT ON fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION fmv_snapshots_floor_topshot_at_best_offer();

-- Editions (Top Shot unless noted):
--   f1 open edition offer 6.00 over a 5.00 price         -> floored to 6.00, marked
--   f2 two open offers 4.00 / 7.00 over 5.00             -> the BEST offer, 7.00
--   f3 open offer 4.00 under 5.00                        -> never lowered
--   f4 open offer 16.00 over 5.00 (> 3x)                 -> ignored (troll/unfunded bound)
--   f5 offer 9.00 but CANCELLED, FILLED, EXPIRED          -> ignored: only live offers count
--   f6 a SERIAL offer 9.00 and a SUBEDITION offer 9.00    -> ignored: edition-level offers only
--   f7 All Day edition with an open offer 9.00            -> out of scope (Top Shot only)
--   f8 offer exactly 15.00 = 3x 5.00                      -> applied (the bound is inclusive)
--   f9 open offer with NULL expiry 6.00                   -> live
INSERT INTO offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000001',  6.00, 'open',      'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000002',  4.00, 'open',      'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000002',  7.00, 'open',      'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000003',  4.00, 'open',      'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000004', 16.00, 'open',      'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000005',  9.00, 'cancelled', 'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000005',  9.00, 'filled',    'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000005',  9.00, 'open',      'edition',    now() - interval '1 hour'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000006',  9.00, 'open',      'serial',     now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000006',  9.00, 'open',      'subedition', now() + interval '1 day'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'f1000000-0000-0000-0000-000000000007',  9.00, 'open',      'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000008', 15.00, 'open',      'edition',    now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1000000-0000-0000-0000-000000000009',  6.00, 'open',      'edition',    NULL);

INSERT INTO fmv_snapshots VALUES
  ('f1000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5.00, 'LOW',      '1.8.3'),
  ('f1000000-0000-0000-0000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5.00, 'MEDIUM',   '1.8.3'),
  ('f1000000-0000-0000-0000-000000000003', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5.00, 'HIGH',     '1.8.3'),
  ('f1000000-0000-0000-0000-000000000004', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5.00, 'LOW',      '1.8.3'),
  ('f1000000-0000-0000-0000-000000000005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5.00, 'LOW',      '1.8.3'),
  ('f1000000-0000-0000-0000-000000000006', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5.00, 'LOW',      '1.8.3'),
  ('f1000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', 5.00, 'LOW',      '1.8.3'),
  ('f1000000-0000-0000-0000-000000000008', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5.00, 'ASK_ONLY', '1.8.3_salescap'),
  ('f1000000-0000-0000-0000-000000000009', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5.00, 'LOW',      '1.8.3'),
  -- NULL / zero prices pass through untouched
  ('f1000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL, 'LOW',      'null-row'),
  ('f1000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 0,    'LOW',      'zero-row');

SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000001' AND algo_version LIKE '1.8.3%'),
  '6.00|1.8.3_bidfloor', 'a price below a live edition offer is raised to it and marked _bidfloor');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000002'),
  '7.00', 'the BEST live offer sets the floor, not any offer');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000003'),
  '5.00|1.8.3', 'an offer under the price never lowers it');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000004'),
  '5.00|1.8.3', 'an offer above 3x the price is ignored (an unfunded or troll offer must not drag a price up)');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000005'),
  '5.00|1.8.3', 'cancelled, filled and expired offers are not live and never set a floor');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000006'),
  '5.00|1.8.3', 'serial and subedition offers are for ONE copy, not the edition, and never set an edition floor');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000007'),
  '5.00|1.8.3', 'the floor is Top Shot only');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000008'),
  '15.00|1.8.3_salescap_bidfloor', 'an offer of exactly 3x applies, and a capped price can be floored after the cap');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'f1000000-0000-0000-0000-000000000009'),
  '6.00', 'an offer with no expiry is live');
SELECT _assert_eq((SELECT coalesce(fmv_usd::text, 'NULL') || '|' || algo_version FROM fmv_snapshots WHERE algo_version = 'null-row'),
  'NULL|null-row', 'a NULL price passes through unchanged');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE algo_version = 'zero-row'),
  '0|zero-row', 'a zero price passes through unchanged (not raised: there is nothing to floor)');
SELECT _assert_eq((SELECT count(*)::text FROM offers), '13', 'the guard reads offers and never writes them');

SELECT '✓ fmv_snapshots_floor_topshot_at_best_offer invariants pass' AS result;
ROLLBACK;
