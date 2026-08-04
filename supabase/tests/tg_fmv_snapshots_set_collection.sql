-- DB invariant: public.tg_fmv_snapshots_set_collection — the BEFORE INSERT trigger
-- that denormalises collections.slug into fmv_snapshots.collection and REFUSES any
-- snapshot whose collection_id is NULL or does not resolve to a real collection.
--
-- Why it matters: fmv_snapshots carries both collection_id (the FK) and collection
-- (the long-form slug text). Essentially every per-collection FMV read keys off one
-- or the other — the trust-health per-collection freshness arms, the confidence-share
-- headline metric, the closed-market confidence cap (which looks the collection up by
-- id), the board filters. This trigger is the ONLY thing guaranteeing those two
-- columns agree and that neither is a fiction.
--
-- The dangerous regression is softening either RAISE into a silent default — writing
-- NULL, '', or a hardcoded 'nba_top_shot' when the lookup misses. Nothing downstream
-- validates the pairing, so unattributed or MIS-attributed snapshots would accumulate
-- quietly and every per-collection number would drift with no failing signal. Failing
-- the insert loudly is the correct behaviour and is what the RAISE assertions pin.
--
-- The second half pins that the trigger is AUTHORITATIVE, not merely a filler: a
-- caller-supplied `collection` is overwritten from the FK, never trusted. If it only
-- filled NULLs, a writer passing a stale or wrong slug alongside a correct id would
-- persist a self-contradictory row — the same self-contradiction class as
-- fmv_snapshots_zero_stale_sales_count (#119), one column disagreeing with another.
--
-- The function DDL below is a VERBATIM copy of the committed migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins. Real collection UUIDs so the fixture reads like production.
CREATE TABLE collections (
  id uuid PRIMARY KEY,
  slug text);

INSERT INTO collections VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
  ('9b4824a8-736d-4a96-b450-8dcc0c46b023', 'ufc_strike');

CREATE TABLE fmv_snapshots (
  edition_id uuid,
  collection_id uuid,
  fmv_usd numeric,
  collection text);

-- >>> BEGIN verbatim tg_fmv_snapshots_set_collection (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.tg_fmv_snapshots_set_collection()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug text;
BEGIN
  IF NEW.collection_id IS NULL THEN
    RAISE EXCEPTION 'fmv_snapshots.collection_id is required';
  END IF;
  SELECT slug INTO v_slug FROM collections WHERE id = NEW.collection_id;
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'fmv_snapshots: unknown collection_id %', NEW.collection_id;
  END IF;
  NEW.collection := v_slug;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim tg_fmv_snapshots_set_collection <<<

CREATE TRIGGER trg_set_collection BEFORE INSERT ON fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION tg_fmv_snapshots_set_collection();

-- ── The slug is denormalised from the FK ────────────────────────────────────────
INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, collection) VALUES
  ('11111111-1111-1111-1111-111111111101', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 100, NULL),
  ('11111111-1111-1111-1111-111111111102', 'dee28451-5d62-409e-a1ad-a83f763ac070', 200, NULL),
  ('11111111-1111-1111-1111-111111111103', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 300, NULL);

SELECT _assert_eq(
  (SELECT string_agg(collection, ',' ORDER BY collection) FROM fmv_snapshots),
  'nba_top_shot,nfl_all_day,ufc_strike',
  'a NULL collection must be filled with the slug its collection_id resolves to');

-- The trigger touches `collection` only — it must never rewrite the id or the value.
SELECT _assert_eq(
  (SELECT collection_id::text || '|' || fmv_usd::text FROM fmv_snapshots
     WHERE edition_id = '11111111-1111-1111-1111-111111111101'),
  '95f28a17-224a-4025-96ad-adf8a4c63bfd|100',
  'the trigger must set collection only, never alter collection_id or fmv_usd');

-- ── The FK is AUTHORITATIVE: a caller-supplied slug is OVERWRITTEN ──────────────
-- Not merely NULL-filled. A writer passing a wrong or stale slug beside a correct id
-- must not be able to persist the disagreement.
INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, collection) VALUES
  ('22222222-2222-2222-2222-222222222201', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 400, 'nfl_all_day'),
  ('22222222-2222-2222-2222-222222222202', 'dee28451-5d62-409e-a1ad-a83f763ac070', 500, 'garbage'),
  ('22222222-2222-2222-2222-222222222203', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 600, '');

SELECT _assert_eq(
  (SELECT string_agg(collection, ',' ORDER BY edition_id) FROM fmv_snapshots
     WHERE edition_id::text LIKE '22222222%'),
  'nba_top_shot,nfl_all_day,ufc_strike',
  'a caller-supplied collection must be overwritten from the FK, never trusted');

-- ── A NULL collection_id is REFUSED, not defaulted ──────────────────────────────
DO $$
BEGIN
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd)
    VALUES ('33333333-3333-3333-3333-333333333301', NULL, 700);
  PERFORM _assert(false, 'a NULL collection_id should have raised');
EXCEPTION WHEN others THEN
  PERFORM _assert(SQLERRM LIKE 'fmv_snapshots.collection_id is required%',
    'a NULL collection_id must RAISE, never silently default: ' || SQLERRM);
END $$;

-- ── An unknown collection_id is REFUSED, not defaulted ──────────────────────────
-- A well-formed uuid that matches no collections row: the lookup misses, v_slug is
-- NULL, and the insert must die rather than land unattributed.
DO $$
BEGIN
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd)
    VALUES ('33333333-3333-3333-3333-333333333302',
            '00000000-0000-0000-0000-0000000000ff', 800);
  PERFORM _assert(false, 'an unknown collection_id should have raised');
EXCEPTION WHEN others THEN
  PERFORM _assert(SQLERRM LIKE 'fmv_snapshots: unknown collection_id%',
    'an unknown collection_id must RAISE, never land unattributed: ' || SQLERRM);
END $$;

-- Neither refused row leaked in, and no row anywhere carries a NULL/empty slug.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots), '6',
  'exactly the 6 valid rows landed — both refused inserts wrote nothing');
SELECT _assert_eq(
  (SELECT count(*)::text FROM fmv_snapshots WHERE collection IS NULL OR collection = ''),
  '0', 'no snapshot may persist with a missing collection slug');

-- Every landed row agrees with its own FK — the invariant every per-collection
-- metric depends on.
SELECT _assert_eq(
  (SELECT count(*)::text FROM fmv_snapshots f
     JOIN collections c ON c.id = f.collection_id
    WHERE f.collection IS DISTINCT FROM c.slug),
  '0', 'collection and collection_id must never disagree on a landed row');

SELECT '✓ tg_fmv_snapshots_set_collection invariants pass' AS result;
ROLLBACK;
