-- DB invariant: public.fmv_snapshots_cap_stale_to_last_sale — the BEFORE INSERT guard on
-- fmv_snapshots that caps an NBA Top Shot or NFL All Day STALE price at the edition's own LAST
-- market sale (any age; serial > 25; price > 0). Measured 2026-10-23 (known-issues #209; migration
-- header): on 60 days of realised sales whose snapshot in force was a CURRENT STALE row (no newer
-- sale behind it), the published STALE price read a median 2.0× (Top Shot, n 236) / 5.0× (All Day,
-- n 61) the price the edition then sold for, within ±25 % 11.4 / 8.2 %; the edition's last sale
-- alone read 1.28× / 2.0× (36.9 / 23.0 %), and min(published, last sale) was the best estimator on
-- every axis for both collections (1.25× / 38.6 % / WAPE 68 and 1.40× / 24.6 % / WAPE 279), never
-- worse in any last-sale age bucket. One trigger covers every writer of a STALE row (fmv-recalc
-- 1.8.x, drain_fmv_cold_tail), which is why it lives in the DB and not in each caller.
-- Claims:
--   R1. a Top Shot STALE row above its edition's last market sale is capped at it, algo_version
--       gains '_stalecap';
--   R2. an All Day STALE row the same;
--   R3. a STALE row at or below the last sale is untouched (the cap only ever LOWERS);
--   R4. a non-STALE row (MEDIUM) is untouched even when above the last sale;
--   R5. a Golazos STALE row is untouched (scope is Top Shot + All Day, by measurement);
--   R6. the last sale is the newest by sold_at, serial > 25 and price > 0 only — a low-serial
--       premium sale and a $0 row do not set the cap; an edition with no qualifying sale is untouched.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261023222201_audit_20261023_fmv_snapshots_cap_stale_to_last_sale.sql); __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins. In production sales_market is a VIEW over sales (minus buy-backs);
-- here a table with the four columns the guard reads is the same shape to the query.
CREATE TABLE sales_market (
  edition_id uuid, sold_at timestamptz, price_usd numeric, serial_number integer);
CREATE TABLE fmv_snapshots (
  edition_id uuid, collection_id uuid, fmv_usd numeric, confidence text, algo_version text);

-- >>> BEGIN verbatim fmv_snapshots_cap_stale_to_last_sale (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_stale_to_last_sale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- NBA Top Shot and NFL All Day (collections.id). Scoped by measurement (2026-10-23, #209).
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_allday  constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_last numeric;
BEGIN
  IF NEW.collection_id IN (c_topshot, c_allday)
     AND NEW.confidence = 'STALE'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT y.price_usd
      INTO v_last
      FROM public.sales_market y
     WHERE y.edition_id = NEW.edition_id
       AND y.price_usd > 0
       AND COALESCE(y.serial_number, 999999) > 25
     ORDER BY y.sold_at DESC
     LIMIT 1;
    IF v_last IS NOT NULL AND v_last > 0 AND NEW.fmv_usd > v_last THEN
      NEW.fmv_usd := round(v_last, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_stalecap';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim fmv_snapshots_cap_stale_to_last_sale <<<

CREATE TRIGGER fmv_snapshots_cap_stale_to_last_sale_trg
  BEFORE INSERT ON fmv_snapshots FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_cap_stale_to_last_sale();

-- Fixtures: E1 (Top Shot) sold 20 then 4 (newest); E2 (All Day) sold 3; E3 (Top Shot) sold 9;
-- E4 (All Day) only a low-serial 50 and a $0 row; E5 (Golazos) sold 1; E6 (Top Shot) no sales.
INSERT INTO sales_market VALUES
  ('00000000-0000-0000-0000-000000000001', now() - interval '200 days', 20, 300),
  ('00000000-0000-0000-0000-000000000001', now() - interval '90 days',   4, 410),
  ('00000000-0000-0000-0000-000000000002', now() - interval '300 days',  3, 120),
  ('00000000-0000-0000-0000-000000000003', now() - interval '100 days',  9, 77),
  ('00000000-0000-0000-0000-000000000004', now() - interval '80 days',  50, 7),
  ('00000000-0000-0000-0000-000000000004', now() - interval '70 days',   0, 500),
  ('00000000-0000-0000-0000-000000000005', now() - interval '90 days',   1, 200);

INSERT INTO fmv_snapshots VALUES
  ('00000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 15, 'STALE',  '1.8.3'),
  ('00000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', 27, 'STALE',  'cold-tail-1.0'),
  ('00000000-0000-0000-0000-000000000003', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  9, 'STALE',  '1.8.3'),
  ('00000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 15, 'MEDIUM', '1.8.3'),
  ('00000000-0000-0000-0000-000000000005', '06248cc4-b85f-47cd-af67-1855d14acd75', 30, 'STALE',  '1.8.3'),
  ('00000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070', 40, 'STALE',  '1.8.3'),
  ('00000000-0000-0000-0000-000000000006', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 12, 'STALE',  '1.8.3');

SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000001' AND confidence = 'STALE'),
                  '4.00|1.8.3_stalecap', 'R1: a Top Shot STALE price above the last sale (4, not the older 20) is capped at it and stamped');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000002'),
                  '3.00|cold-tail-1.0_stalecap', 'R2: an All Day cold-tail STALE price is capped at its last sale');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000003'),
                  '9|1.8.3', 'R3: a STALE price at the last sale is untouched (the cap only lowers)');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000001' AND confidence = 'MEDIUM'),
                  '15|1.8.3', 'R4: a MEDIUM row is never capped by this guard');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000005'),
                  '30|1.8.3', 'R5: a Golazos STALE row is out of scope');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000004'),
                  '40|1.8.3', 'R6: a low-serial premium sale and a $0 row do not set the cap');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000006'),
                  '12|1.8.3', 'R6: an edition with no qualifying sale is untouched');

SELECT '✓ fmv_snapshots_cap_stale_to_last_sale invariants pass' AS result;

ROLLBACK;
