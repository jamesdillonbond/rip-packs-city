-- DB invariant: public.compute_ultimate_non_special_fmv(uuid) — a per-edition FMV
-- estimator for ULTIMATE-tier editions that EXCLUDES the collection's "special
-- serials" (from get_ultimate_special_serials) from BOTH the last-sale and
-- lowest-ask lookups, so a jersey-match / first-mint serial can't drag the base
-- edition's FMV. Load-bearing invariants pinned here:
--   * the special-serial EXCLUSION (a 5000 sale / 6000 ask on serial 1 is ignored
--     when serial 1 is special and circ > 1);
--   * the FMV source LADDER min(sale,ask) -> sale_only -> ask_only -> no_data with
--     confidences LOW / SALES_ONLY / ASK_ONLY / NO_DATA;
--   * the ULTIMATE tier gate (a non-ULTIMATE edition returns NO rows);
--   * filter_skipped = (circ IS NULL OR circ <= 1), which DISABLES the special
--     filter (a lone 1-of-1's only sale counts even if flagged special).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231600_audit_20260801_snapshot_compute_ultimate_non_special_fmv.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (766371c0f64596720e03d43a9477c55e).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE players (id uuid PRIMARY KEY, jersey_number integer);
CREATE TABLE editions (
  id uuid PRIMARY KEY, tier text, circulation_count integer,
  player_id uuid, player_name text, set_name text, collection_id uuid
);
CREATE TABLE sales (
  edition_id uuid, serial_number integer, price_usd numeric, sold_at timestamptz
);
CREATE TABLE cached_listings (
  collection_id uuid, tier text, player_name text, set_name text,
  ask_price numeric, serial_number integer
);

-- Stub the special-serials helper: serial 1 is "special" for every edition.
CREATE FUNCTION get_ultimate_special_serials(p_edition_id uuid)
  RETURNS integer[] LANGUAGE sql AS $$ SELECT ARRAY[1]::integer[] $$;

-- >>> BEGIN verbatim compute_ultimate_non_special_fmv (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.compute_ultimate_non_special_fmv(p_edition_id uuid)
 RETURNS TABLE(edition_id uuid, collection_id uuid, collection_slug text, circulation integer, jersey_number integer, special_serials integer[], filter_skipped boolean, last_non_special_sale_price numeric, last_non_special_sale_at timestamp with time zone, days_since_sale integer, lowest_non_special_ask numeric, fmv_usd numeric, source text, confidence text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_circ int;
  v_player_id uuid;
  v_jersey int;
  v_collection_id uuid;
  v_collection_slug text;
  v_player_name text;
  v_set_name text;
  v_specials int[];
  v_skip boolean;
  v_last_sale numeric;
  v_last_at timestamptz;
  v_days int;
  v_low_ask numeric;
  v_fmv numeric;
  v_source text;
  v_conf text;
BEGIN
  SELECT e.collection_id, c.slug, e.circulation_count, e.player_id, e.player_name, e.set_name
    INTO v_collection_id, v_collection_slug, v_circ, v_player_id, v_player_name, v_set_name
  FROM editions e
  JOIN collections c ON c.id = e.collection_id
  WHERE e.id = p_edition_id AND e.tier = 'ULTIMATE';

  IF NOT FOUND THEN RETURN; END IF;

  v_skip := (v_circ IS NULL OR v_circ <= 1);
  v_specials := get_ultimate_special_serials(p_edition_id);

  IF v_player_id IS NOT NULL THEN
    SELECT p.jersey_number INTO v_jersey FROM players p WHERE p.id = v_player_id;
  END IF;

  SELECT s.price_usd, s.sold_at
    INTO v_last_sale, v_last_at
  FROM sales s
  WHERE s.edition_id = p_edition_id
    AND s.price_usd > 0
    AND (v_skip OR NOT (s.serial_number = ANY(v_specials)))
  ORDER BY s.sold_at DESC
  LIMIT 1;

  IF v_last_at IS NOT NULL THEN
    v_days := EXTRACT(DAY FROM (now() - v_last_at))::int;
  END IF;

  IF v_player_name IS NOT NULL AND v_set_name IS NOT NULL THEN
    SELECT MIN(cl.ask_price)
      INTO v_low_ask
    FROM cached_listings cl
    WHERE cl.collection_id = v_collection_id
      AND cl.tier = 'ULTIMATE'
      AND cl.player_name = v_player_name
      AND cl.set_name = v_set_name
      AND cl.ask_price > 0
      AND (v_skip OR NOT (cl.serial_number = ANY(v_specials)));
  END IF;

  IF v_last_sale IS NOT NULL AND v_low_ask IS NOT NULL THEN
    v_fmv := LEAST(v_last_sale, v_low_ask);
    v_source := 'min_sale_ask';
    v_conf := 'LOW';
  ELSIF v_last_sale IS NOT NULL THEN
    v_fmv := v_last_sale;
    v_source := 'sale_only';
    v_conf := 'SALES_ONLY';
  ELSIF v_low_ask IS NOT NULL THEN
    v_fmv := v_low_ask;
    v_source := 'ask_only';
    v_conf := 'ASK_ONLY';
  ELSE
    v_fmv := NULL;
    v_source := 'no_data';
    v_conf := 'NO_DATA';
  END IF;

  RETURN QUERY SELECT
    p_edition_id, v_collection_id, v_collection_slug, v_circ, v_jersey, v_specials, v_skip,
    v_last_sale, v_last_at, v_days, v_low_ask, v_fmv, v_source, v_conf;
END;
$function$;
-- <<< END verbatim compute_ultimate_non_special_fmv <<<

INSERT INTO collections (id, slug) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nba-top-shot');
INSERT INTO players (id, jersey_number) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 23);

INSERT INTO editions (id, tier, circulation_count, player_id, player_name, set_name, collection_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'ULTIMATE', 10, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Star',    'S1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), -- both -> min_sale_ask
  ('22222222-2222-2222-2222-222222222222', 'ULTIMATE',  5, NULL, 'Solo',    'S2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), -- sale only
  ('33333333-3333-3333-3333-333333333333', 'ULTIMATE',  5, NULL, 'AskOnly', 'S3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), -- ask only
  ('44444444-4444-4444-4444-444444444444', 'ULTIMATE',  5, NULL, 'Empty',   'S4', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), -- no data
  ('55555555-5555-5555-5555-555555555555', 'RARE',      5, NULL, 'NotUlt',  'S5', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), -- tier gate: no rows
  ('66666666-6666-6666-6666-666666666666', 'ULTIMATE',  1, NULL, 'Single',  'S6', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); -- circ=1 -> filter skipped

-- E1: special serial 1 has the newest sale (5000) and cheapest ask (6000) but is
-- EXCLUDED; the winning sale is serial 5 @ 100, the winning ask serial 9 @ 200.
INSERT INTO sales (edition_id, serial_number, price_usd, sold_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 1, 5000, now() - interval '1 hour'),  -- special -> excluded
  ('11111111-1111-1111-1111-111111111111', 5, 100,  now() - interval '2 hours'), -- newest non-special
  ('11111111-1111-1111-1111-111111111111', 8, 120,  now() - interval '3 hours');
INSERT INTO cached_listings (collection_id, tier, player_name, set_name, ask_price, serial_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ULTIMATE', 'Star', 'S1', 6000, 1),  -- special -> excluded
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ULTIMATE', 'Star', 'S1', 200,  9),  -- min non-special ask
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ULTIMATE', 'Star', 'S1', 250,  3);
-- E2: sale only
INSERT INTO sales (edition_id, serial_number, price_usd, sold_at) VALUES
  ('22222222-2222-2222-2222-222222222222', 3, 300, now() - interval '1 day');
-- E3: ask only
INSERT INTO cached_listings (collection_id, tier, player_name, set_name, ask_price, serial_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ULTIMATE', 'AskOnly', 'S3', 400, 3);
-- E6: only sale is the special serial 1 @ 9999, but circ=1 -> filter skipped -> counts.
INSERT INTO sales (edition_id, serial_number, price_usd, sold_at) VALUES
  ('66666666-6666-6666-6666-666666666666', 1, 9999, now() - interval '1 day');

-- 1) E1: min_sale_ask ladder, and the special serial is excluded on BOTH legs.
SELECT _assert_eq((SELECT source      FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), 'min_sale_ask', 'E1 source is min_sale_ask');
SELECT _assert_eq((SELECT confidence  FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), 'LOW',          'E1 confidence LOW');
SELECT _assert_eq((SELECT fmv_usd::text FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), '100', 'E1 fmv = LEAST(sale 100, ask 200)');
SELECT _assert_eq((SELECT last_non_special_sale_price::text FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), '100', 'E1 last-sale excludes the special serial-1 @ 5000');
SELECT _assert_eq((SELECT lowest_non_special_ask::text FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), '200', 'E1 low-ask excludes the special serial-1 @ 6000');
SELECT _assert_eq((SELECT filter_skipped::text FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), 'false', 'E1 circ 10 -> filter active');
SELECT _assert_eq((SELECT jersey_number::text FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), '23', 'E1 jersey number resolved from players');
SELECT _assert_eq((SELECT special_serials::text FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), '{1}', 'E1 special_serials surfaced from the helper');
SELECT _assert_eq((SELECT circulation::text FROM compute_ultimate_non_special_fmv('11111111-1111-1111-1111-111111111111')), '10', 'E1 circulation passed through');

-- 2) E2: sale only.
SELECT _assert_eq((SELECT source||'|'||confidence||'|'||fmv_usd::text FROM compute_ultimate_non_special_fmv('22222222-2222-2222-2222-222222222222')), 'sale_only|SALES_ONLY|300', 'E2 sale-only branch');

-- 3) E3: ask only.
SELECT _assert_eq((SELECT source||'|'||confidence||'|'||fmv_usd::text FROM compute_ultimate_non_special_fmv('33333333-3333-3333-3333-333333333333')), 'ask_only|ASK_ONLY|400', 'E3 ask-only branch');

-- 4) E4: no data -> NULL fmv.
SELECT _assert_eq((SELECT source||'|'||confidence FROM compute_ultimate_non_special_fmv('44444444-4444-4444-4444-444444444444')), 'no_data|NO_DATA', 'E4 no-data branch');
SELECT _assert_eq((SELECT fmv_usd IS NULL FROM compute_ultimate_non_special_fmv('44444444-4444-4444-4444-444444444444'))::text, 'true', 'E4 fmv is NULL');

-- 5) E5: non-ULTIMATE tier -> function returns NO rows.
SELECT _assert_eq((SELECT count(*)::text FROM compute_ultimate_non_special_fmv('55555555-5555-5555-5555-555555555555')), '0', 'a non-ULTIMATE edition yields no rows');

-- 6) E6: circ=1 -> filter_skipped, so even the flagged serial-1 sale counts.
SELECT _assert_eq((SELECT filter_skipped::text FROM compute_ultimate_non_special_fmv('66666666-6666-6666-6666-666666666666')), 'true', 'E6 circ 1 -> filter skipped');
SELECT _assert_eq((SELECT last_non_special_sale_price::text FROM compute_ultimate_non_special_fmv('66666666-6666-6666-6666-666666666666')), '9999', 'E6 the special serial-1 sale is NOT excluded when filter is skipped');

SELECT '✓ compute_ultimate_non_special_fmv invariants pass' AS result;
ROLLBACK;
