-- DB invariant: public.fmv_snapshots_cap_panini_low_to_live_ask — the BEFORE INSERT guard on fmv_snapshots
-- that caps a Panini LOW price at the edition's lowest LIVE ask (listed serials re-read in the last 7 days).
-- Decided 2026-10-26 (known-issues #202, panini-1.4.1) on the forward shadow log panini_fmv_ask_cap_shadow:
-- on the 82 sales the cap changed, within ±25 % of the next sale 1.2 % -> 53.7 %, median ratio 2.0 -> 1.06,
-- and no tier lost on the full 2,484-sale population. One trigger covers every Panini FMV writer.
-- Claims:
--   R1. a Panini LOW row above its lowest confirmed ask is capped at it, algo_version gains '_askcap';
--   R2. a LOW row at or below the ask is untouched (the cap only ever LOWERS);
--   R3. a non-LOW Panini row (HIGH) is untouched even when above the ask;
--   R4. a non-Panini LOW row is untouched (scope is Panini, by measurement);
--   R5. only a LISTED serial with price > 0 re-read in the last 7 days sets the cap — an unlisted serial, a
--       $0 listing and a 10-day-old read do not; an edition with no confirmed ask is untouched.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261027030854_audit_20261026_panini_fmv_low_cap_to_live_ask.sql); __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins with only the columns the guard reads.
CREATE TABLE editions (id uuid, external_id varchar);
CREATE TABLE panini_card_serials (
  edition_external_id text, is_listed boolean, price_usd numeric, captured_at timestamptz);
CREATE TABLE fmv_snapshots (
  edition_id uuid, collection_id uuid, fmv_usd numeric, confidence text, algo_version text);

-- >>> BEGIN verbatim fmv_snapshots_cap_panini_low_to_live_ask (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_panini_low_to_live_ask()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Panini Blockchain (collections.id). Scoped by measurement (2026-10-26, #202).
  c_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_ask numeric;
BEGIN
  IF NEW.collection_id = c_panini
     AND NEW.confidence = 'LOW'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT min(s.price_usd)
      INTO v_ask
      FROM public.editions e
      JOIN public.panini_card_serials s
        ON s.edition_external_id = e.external_id::text
     WHERE e.id = NEW.edition_id
       AND s.is_listed
       AND s.price_usd > 0
       AND s.captured_at > now() - interval '7 days';
    IF v_ask IS NOT NULL AND v_ask > 0 AND NEW.fmv_usd > v_ask THEN
      NEW.fmv_usd := round(v_ask, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_askcap';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim fmv_snapshots_cap_panini_low_to_live_ask <<<

CREATE TRIGGER fmv_snapshots_cap_panini_low_to_live_ask_trg
  BEFORE INSERT ON fmv_snapshots FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_cap_panini_low_to_live_ask();

-- Fixtures: P1 asks 3 (fresh) and 1 (unlisted) and 0.5 (10 days old) and 0 (listed at $0);
-- P2 ask 10; P3 no listing at all; T1 is a Top Shot edition with a "serial" row keyed the same way.
INSERT INTO editions VALUES
  ('00000000-0000-0000-0000-000000000001', 'P1'),
  ('00000000-0000-0000-0000-000000000002', 'P2'),
  ('00000000-0000-0000-0000-000000000003', 'P3'),
  ('00000000-0000-0000-0000-000000000004', 'T1');
INSERT INTO panini_card_serials VALUES
  ('P1', true,  3,   now() - interval '1 day'),
  ('P1', false, 1,   now() - interval '1 day'),
  ('P1', true,  0.5, now() - interval '10 days'),
  ('P1', true,  0,   now() - interval '1 day'),
  ('P2', true,  10,  now() - interval '2 days'),
  ('T1', true,  2,   now() - interval '1 day');

INSERT INTO fmv_snapshots VALUES
  ('00000000-0000-0000-0000-000000000001', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 198, 'LOW',  'panini-1.4.0'),
  ('00000000-0000-0000-0000-000000000002', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b',   8, 'LOW',  'panini-1.4.0'),
  ('00000000-0000-0000-0000-000000000001', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 198, 'HIGH', 'panini-1.4.0'),
  ('00000000-0000-0000-0000-000000000004', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  50, 'LOW',  '1.8.3'),
  ('00000000-0000-0000-0000-000000000003', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b',  40, 'LOW',  'panini-1.4.0');

SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000001' AND confidence = 'LOW'),
                  '3.00|panini-1.4.0_askcap', 'R1+R5: a LOW price above the fresh listed ask (3, not the unlisted 1, the stale 0.5 or the $0) is capped at it and stamped');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000002'),
                  '8|panini-1.4.0', 'R2: a LOW price below the ask is untouched (the cap only lowers)');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000001' AND confidence = 'HIGH'),
                  '198|panini-1.4.0', 'R3: a HIGH row is never capped by this guard');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000004'),
                  '50|1.8.3', 'R4: a Top Shot LOW row is out of scope');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000003'),
                  '40|panini-1.4.0', 'R5: an edition with no confirmed ask is untouched');

SELECT '✓ fmv_snapshots_cap_panini_low_to_live_ask invariants pass' AS result;

ROLLBACK;
