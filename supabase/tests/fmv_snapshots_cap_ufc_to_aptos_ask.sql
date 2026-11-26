-- DB invariant: public.fmv_snapshots_cap_ufc_to_aptos_ask — the BEFORE INSERT guard on fmv_snapshots that caps a
-- UFC Strike FMV at the edition's cheapest LIVE single-Moment Rarible ask on Aptos (priced at the latest APT/USD close).
-- Decided 2026-11-26 (Trevor, "Do it all") on the 2026-11-26 read: FMV above the live ask on 350 of 438 editions, median
-- FMV / ask 1.81, UFC's store wallet setting 95 % of floors, 1 sale in ~5 weeks (claude/ufc-aptos-status-2026-11-25.md).
-- Claims:
--   R1. a UFC row above the cheapest live single ask is capped at ask_apt x latest APT close, algo_version gains _aptoscap;
--   R2. a UFC row at or below that ask is untouched (the cap only ever LOWERS);
--   R3. only a SINGLE listing with price_apt > 0 re-confirmed within 3 days sets the cap — a bundle, a $0 listing and a
--       5-day-old check do not; an edition with no live single listing is untouched;
--   R4. every confidence tier is in scope except NO_DATA (STALE and ASK_ONLY included);
--   R5. a non-UFC row is untouched even with a matching listing row.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261126174033_audit_20261126_ufc_reopen_on_aptos_and_ask_cap.sql); __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE ufc_aptos_listings (
  edition_id uuid, kind text, price_apt numeric, last_checked_at timestamptz);
CREATE TABLE apt_usd_daily (day date, usd numeric);
CREATE TABLE fmv_snapshots (
  edition_id uuid, collection_id uuid, fmv_usd numeric, confidence text, algo_version text);

-- >>> BEGIN verbatim fmv_snapshots_cap_ufc_to_aptos_ask (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_ufc_to_aptos_ask()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- UFC Strike (collections.id). Scoped by measurement (2026-11-26, claude/ufc-aptos-status-2026-11-25.md).
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  v_ask_apt numeric;
  v_apt_usd numeric;
  v_ask numeric;
BEGIN
  IF NEW.collection_id = c_ufc
     AND NEW.confidence IS DISTINCT FROM 'NO_DATA'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT min(l.price_apt)
      INTO v_ask_apt
      FROM public.ufc_aptos_listings l
     WHERE l.edition_id = NEW.edition_id
       AND l.kind = 'single'
       AND l.price_apt > 0
       AND l.last_checked_at > now() - interval '3 days';
    IF v_ask_apt IS NOT NULL THEN
      SELECT d.usd INTO v_apt_usd FROM public.apt_usd_daily d WHERE d.usd > 0 ORDER BY d.day DESC LIMIT 1;
      v_ask := round(v_ask_apt * v_apt_usd, 2);
      IF v_ask IS NOT NULL AND v_ask > 0 AND NEW.fmv_usd > v_ask THEN
        NEW.fmv_usd := v_ask;
        NEW.algo_version := COALESCE(NEW.algo_version, '') || '_aptoscap';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim fmv_snapshots_cap_ufc_to_aptos_ask <<<

CREATE TRIGGER fmv_snapshots_cap_ufc_to_aptos_ask_trg
  BEFORE INSERT ON fmv_snapshots FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_cap_ufc_to_aptos_ask();

-- APT closes: the LATEST day (0.40) is the one used, not the older 0.50.
INSERT INTO apt_usd_daily VALUES (current_date - 3, 0.50), (current_date - 1, 0.40);
-- U1: live singles 5 and 4 APT (cheapest 4 -> $1.60), a bundle at 1, a $0 listing, a 5-day-old check at 2.
-- U2: live single 10 APT ($4.00).  U3: nothing live.  T1: a Top Shot edition with a "listing" row (out of scope).
INSERT INTO ufc_aptos_listings VALUES
  ('00000000-0000-0000-0000-000000000001', 'single', 5, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000001', 'single', 4, now() - interval '12 hours'),
  ('00000000-0000-0000-0000-000000000001', 'bundle', 1, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000001', 'single', 0, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000001', 'single', 2, now() - interval '5 days'),
  ('00000000-0000-0000-0000-000000000002', 'single', 10, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000003', 'single', 1, now() - interval '10 days'),
  ('00000000-0000-0000-0000-000000000004', 'single', 1, now() - interval '1 hour');

INSERT INTO fmv_snapshots VALUES
  ('00000000-0000-0000-0000-000000000001', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 3.00, 'MEDIUM',   '1.8.3'),
  ('00000000-0000-0000-0000-000000000001', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 2.50, 'STALE',    'cold-tail-1.0'),
  ('00000000-0000-0000-0000-000000000001', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 2.40, 'ASK_ONLY', '1.8.3'),
  ('00000000-0000-0000-0000-000000000001', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 9.99, 'NO_DATA',  'cold-tail-1.0'),
  ('00000000-0000-0000-0000-000000000002', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 3.00, 'HIGH',     '1.8.3'),
  ('00000000-0000-0000-0000-000000000003', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 7.00, 'LOW',      '1.8.3'),
  ('00000000-0000-0000-0000-000000000004', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 50, 'LOW',       '1.8.3');

SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000001' AND confidence = 'MEDIUM'),
                  '1.60|1.8.3_aptoscap', 'R1+R3: capped at the cheapest LIVE single (4 APT x 0.40) — not the bundle, the $0 or the 5-day-old 2 APT');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000001' AND confidence = 'STALE'),
                  '1.60|cold-tail-1.0_aptoscap', 'R4: a STALE row is capped too');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000001' AND confidence = 'ASK_ONLY'),
                  '1.60|1.8.3_aptoscap', 'R4: an ASK_ONLY row is capped too');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000001' AND confidence = 'NO_DATA'),
                  '9.99|cold-tail-1.0', 'R4: a NO_DATA row is untouched');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000002'),
                  '3.00|1.8.3', 'R2: below the ask ($4.00) is untouched — the cap only lowers');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000003'),
                  '7.00|1.8.3', 'R3: an edition whose only listing was checked 10 days ago is untouched');
SELECT _assert_eq((SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots WHERE edition_id = '00000000-0000-0000-0000-000000000004'),
                  '50|1.8.3', 'R5: a non-UFC row is out of scope');

SELECT '✓ fmv_snapshots_cap_ufc_to_aptos_ask invariants pass' AS result;

ROLLBACK;
