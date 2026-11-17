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
--   R7. (2026-11-05, #213) an All Day edition with circulation <= 50 is capped at its last sale that is not a
--       PREMIUM serial (#1, the jersey number, the last mint) — a newer low-serial sale (#9) DOES set the cap;
--   R8. ...and the premium serials themselves (#1, jersey, last mint) do not;
--   R9. an All Day edition with circulation > 50 keeps the serial > 25 rule;
--   R10. a Top Shot edition with circulation <= 50 keeps the serial > 25 rule (scope is All Day by measurement).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261105213600_audit_20261105_allday_stale_cap_skips_premium_serials.sql); __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins. In production sales_market is a VIEW over sales (minus buy-backs);
-- here a table with the four columns the guard reads is the same shape to the query.
CREATE TABLE sales_market (
  edition_id uuid, sold_at timestamptz, price_usd numeric, serial_number integer);
CREATE TABLE fmv_snapshots (
  edition_id uuid, collection_id uuid, fmv_usd numeric, confidence text, algo_version text);
-- editions carries the two columns the All Day small-edition arm reads (2026-11-05).
CREATE TABLE editions (id uuid, circulation_count integer, jersey_number smallint);

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
  v_circ integer;
  v_jersey integer;
BEGIN
  IF NEW.collection_id IN (c_topshot, c_allday)
     AND NEW.confidence = 'STALE'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    IF NEW.collection_id = c_allday THEN
      SELECT e.circulation_count, e.jersey_number INTO v_circ, v_jersey
        FROM public.editions e WHERE e.id = NEW.edition_id;
    END IF;

    IF NEW.collection_id = c_allday AND v_circ IS NOT NULL AND v_circ <= 50 THEN
      -- 2026-11-05 (#213): on a small All Day edition, skip only the PREMIUM serials
      -- (#1, the jersey number, the last mint) — serial > 25 ignores most of the supply.
      SELECT y.price_usd
        INTO v_last
        FROM public.sales_market y
       WHERE y.edition_id = NEW.edition_id
         AND y.price_usd > 0
         AND y.serial_number IS DISTINCT FROM 1
         AND y.serial_number IS DISTINCT FROM v_jersey
         AND y.serial_number IS DISTINCT FROM v_circ
       ORDER BY y.sold_at DESC
       LIMIT 1;
    ELSE
      SELECT y.price_usd
        INTO v_last
        FROM public.sales_market y
       WHERE y.edition_id = NEW.edition_id
         AND y.price_usd > 0
         AND COALESCE(y.serial_number, 999999) > 25
       ORDER BY y.sold_at DESC
       LIMIT 1;
    END IF;

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

-- 2026-11-05 (#213) fixtures. E7: All Day /30, jersey 95 — the /nfl-all-day/edition/1919 shape: #26 sold 520
-- (old), #9 sold 69 (newest non-premium). E8: All Day /30, jersey 12 — newest sales are #1, #12 (jersey) and #30
-- (last mint), the newest NON-premium is #26 at 400. E9: All Day /100 — #9 sold 69 newest, #40 sold 300 older.
-- E10: Top Shot /30 — #9 sold 69 newest, #40 sold 300 older.
INSERT INTO editions VALUES
  ('00000000-0000-0000-0000-000000000007', 30, 95),
  ('00000000-0000-0000-0000-000000000008', 30, 12),
  ('00000000-0000-0000-0000-000000000009', 100, 7),
  ('00000000-0000-0000-0000-00000000000a', 30, 3);
INSERT INTO sales_market VALUES
  ('00000000-0000-0000-0000-000000000007', now() - interval '640 days', 520, 26),
  ('00000000-0000-0000-0000-000000000007', now() - interval '280 days',  69, 9),
  ('00000000-0000-0000-0000-000000000008', now() - interval '400 days', 400, 26),
  ('00000000-0000-0000-0000-000000000008', now() - interval '30 days',   50, 1),
  ('00000000-0000-0000-0000-000000000008', now() - interval '20 days',   60, 12),
  ('00000000-0000-0000-0000-000000000008', now() - interval '10 days',   70, 30),
  ('00000000-0000-0000-0000-000000000009', now() - interval '200 days', 300, 40),
  ('00000000-0000-0000-0000-000000000009', now() - interval '20 days',   69, 9),
  ('00000000-0000-0000-0000-00000000000a', now() - interval '200 days', 300, 40),
  ('00000000-0000-0000-0000-00000000000a', now() - interval '20 days',   69, 9);
INSERT INTO fmv_snapshots VALUES
  ('00000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', 600, 'STALE', 'thin-sales-guard-v3'),
  ('00000000-0000-0000-0000-000000000008', 'dee28451-5d62-409e-a1ad-a83f763ac070', 900, 'STALE', 'thin-sales-guard-v3'),
  ('00000000-0000-0000-0000-000000000009', 'dee28451-5d62-409e-a1ad-a83f763ac070', 500, 'STALE', 'thin-sales-guard-v3'),
  ('00000000-0000-0000-0000-00000000000a', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 500, 'STALE', '1.8.3');

SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000007'),
                  '69.00|thin-sales-guard-v3_stalecap', 'R7: a small All Day edition is capped at its newest non-premium sale (#9 at 69), not the old #26 at 520');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000008'),
                  '400.00|thin-sales-guard-v3_stalecap', 'R8: #1, the jersey number and the last mint do not set the cap — the newest non-premium sale (#26 at 400) does');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000009'),
                  '300.00|thin-sales-guard-v3_stalecap', 'R9: an All Day edition over circulation 50 keeps the serial > 25 rule (#40 at 300, not #9 at 69)');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-00000000000a'),
                  '300.00|1.8.3_stalecap', 'R10: a small Top Shot edition keeps the serial > 25 rule (scope is All Day)');

SELECT '✓ fmv_snapshots_cap_stale_to_last_sale invariants pass' AS result;

ROLLBACK;
