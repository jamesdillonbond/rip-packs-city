-- DB invariant: public.fmv_from_cached_listings — derives ASK_ONLY FMV rows from
-- the Flowty listing cache for editions that have no HIGH/MEDIUM (sales-backed)
-- FMV yet. It prefers the average of Flowty's own pre-computed FMV, falls back to
-- the min ask ONLY when that ask is under a $5000 sanity ceiling (else writes
-- nothing rather than $1M garbage), replaces any stale ASK_ONLY/LOW row for the
-- same edition, and never touches an edition that already has a HIGH/MEDIUM row.
-- DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- The confidence enum (prod type; recreated here so the ::fmv_confidence casts resolve).
CREATE TYPE fmv_confidence AS ENUM ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

-- normalize_name lives in the base schema (not in the repo migrations). All the
-- fixtures below match editions ↔ listings by moment_id, giving every row a
-- DISTINCT player/set name so the name-normalization OR-branch is never the
-- matching path — this stand-in only needs to exist and be deterministic.
CREATE OR REPLACE FUNCTION public.normalize_name(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT lower(coalesce(trim(p), '')) $$;

CREATE TABLE editions (
  id uuid PRIMARY KEY, collection_id uuid, external_id text, player_name text, set_name text);
CREATE TABLE cached_listings (
  id bigserial PRIMARY KEY, collection_id uuid, moment_id text,
  player_name text, set_name text, ask_price numeric, fmv numeric);
CREATE TABLE fmv_snapshots (
  id bigserial PRIMARY KEY, edition_id uuid, collection_id uuid, fmv_usd numeric,
  floor_price_usd numeric, asp_usd numeric, confidence fmv_confidence,
  listing_count int, algo_version text, computed_at timestamptz DEFAULT now(),
  liquidity_rating int, top_shot_ask numeric, flowty_ask numeric, cross_market_ask numeric);

-- >>> BEGIN verbatim fmv_from_cached_listings (byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_from_cached_listings(p_collection_id uuid, p_algo_version text DEFAULT 'ask_only_v2'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  rows_inserted integer := 0;
  ask_price_ceiling numeric := 5000;
BEGIN
  -- Targeted DELETE: only ASK_ONLY/LOW rows for editions matched by cached_listings without HIGH/MEDIUM
  DELETE FROM fmv_snapshots fs
  WHERE fs.collection_id = p_collection_id
    AND fs.confidence IN ('ASK_ONLY'::fmv_confidence, 'LOW'::fmv_confidence)
    AND fs.edition_id IN (
      SELECT DISTINCT e.id
      FROM cached_listings cl
      JOIN editions e ON e.collection_id = p_collection_id
        AND (
          (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
          OR
          (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
           AND normalize_name(e.player_name) = normalize_name(cl.player_name)
           AND normalize_name(e.set_name) = normalize_name(cl.set_name))
        )
      WHERE cl.collection_id = p_collection_id
        AND cl.ask_price > 0
        AND NOT EXISTS (
          SELECT 1 FROM fmv_snapshots f2
          WHERE f2.edition_id = e.id
            AND f2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence)
        )
    );

  -- INSERT new ASK_ONLY rows with sanity ceiling on the fallback path
  INSERT INTO fmv_snapshots (
    edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
    confidence, listing_count, algo_version, computed_at,
    liquidity_rating, top_shot_ask, flowty_ask, cross_market_ask
  )
  SELECT
    e.id AS edition_id,
    p_collection_id,
    -- Primary: avg of cl.fmv when present (Flowty's pre-computed FMV is trustworthy)
    -- Fallback: MIN(ask_price) only when cl.fmv is missing AND the ask is below the ceiling
    COALESCE(
      NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
      CASE
        WHEN MIN(cl.ask_price) <= ask_price_ceiling
        THEN ROUND(MIN(cl.ask_price), 2)
        ELSE NULL  -- no FMV row produced — better silence than $1M garbage
      END
    ) AS fmv_usd,
    ROUND(MIN(cl.ask_price), 2) AS floor_price_usd,
    NULL AS wap_usd,
    'ASK_ONLY'::fmv_confidence AS confidence,
    COUNT(cl.id)::int AS listing_count,
    p_algo_version,
    NOW(),
    1 AS liquidity_rating,
    NULL AS top_shot_ask,
    ROUND(MIN(cl.ask_price), 2) AS flowty_ask,
    ROUND(MIN(cl.ask_price), 2) AS cross_market_ask
  FROM cached_listings cl
  JOIN editions e ON e.collection_id = p_collection_id
    AND (
      (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
      OR
      (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
       AND normalize_name(e.player_name) = normalize_name(cl.player_name)
       AND normalize_name(e.set_name) = normalize_name(cl.set_name))
    )
  WHERE cl.collection_id = p_collection_id
    AND cl.ask_price > 0
    AND NOT EXISTS (
      SELECT 1 FROM fmv_snapshots fs2
      WHERE fs2.edition_id = e.id
        AND fs2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence)
    )
  GROUP BY e.id
  -- HAVING clause excludes editions where the resulting fmv_usd would be NULL
  HAVING COALESCE(
    NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
    CASE
      WHEN MIN(cl.ask_price) <= ask_price_ceiling
      THEN ROUND(MIN(cl.ask_price), 2)
      ELSE NULL
    END
  ) IS NOT NULL;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  RETURN rows_inserted;
END;
$function$;
-- <<< END verbatim fmv_from_cached_listings <<<

DO $seed$
DECLARE
  c uuid := '06248cc4-b85f-47cd-af67-1855d14acd75'; -- golazos (any non-null collection)
  e1 uuid := 'ed000001-0000-0000-0000-000000000001';
  e2 uuid := 'ed000002-0000-0000-0000-000000000002';
  e3 uuid := 'ed000003-0000-0000-0000-000000000003';
  e4 uuid := 'ed000004-0000-0000-0000-000000000004';
BEGIN
  INSERT INTO editions (id, collection_id, external_id, player_name, set_name) VALUES
    (e1,c,'M1','P1','S1'),(e2,c,'M2','P2','S2'),(e3,c,'M3','P3','S3'),(e4,c,'M4','P4','S4');

  -- E1: two listings carrying Flowty FMV 10 & 20 → avg = 15 (primary path)
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv) VALUES
    (c,'M1','P1','S1',30,10),(c,'M1','P1','S1',40,20);
  -- E1 already has a stale ASK_ONLY row that must be REPLACED
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version)
    VALUES (e1,c,999,'ASK_ONLY','old');

  -- E2: listings with no usable FMV, ask 50 (<= ceiling) → falls back to ask 50
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv) VALUES
    (c,'M2','P2','S2',50,0),(c,'M2','P2','S2',70,NULL);

  -- E3: no FMV and ask 6000 (> $5000 ceiling) → HAVING excludes → NO row written
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv) VALUES
    (c,'M3','P3','S3',6000,0);

  -- E4: matched by a listing BUT already has a HIGH (sales-backed) row → untouched
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv) VALUES
    (c,'M4','P4','S4',25,12);
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version)
    VALUES (e4,c,500,'HIGH','sales_v1');
END $seed$;

-- Returns the count of ASK_ONLY rows written: E1 (replace) + E2 (ask fallback) = 2.
SELECT _assert_eq(
  (fmv_from_cached_listings('06248cc4-b85f-47cd-af67-1855d14acd75'::uuid))::text,
  '2', 'writes 2 ASK_ONLY rows (E1 avg-FMV + E2 ask-fallback)');

-- E1: exactly one ASK_ONLY row now, FMV = avg(10,20) = 15, floor = min(ask) = 30.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots WHERE edition_id = 'ed000001-0000-0000-0000-000000000001'),
  '1', 'stale E1 ASK_ONLY row replaced, not duplicated');
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'ed000001-0000-0000-0000-000000000001'),
  '15.00', 'E1 FMV = average of Flowty FMV 10 & 20');
SELECT _assert_eq((SELECT floor_price_usd::text FROM fmv_snapshots WHERE edition_id = 'ed000001-0000-0000-0000-000000000001'),
  '30.00', 'E1 floor = min ask');
SELECT _assert_eq((SELECT confidence::text FROM fmv_snapshots WHERE edition_id = 'ed000001-0000-0000-0000-000000000001'),
  'ASK_ONLY', 'E1 row is ASK_ONLY');

-- E2: ask fallback (no usable Flowty FMV) → FMV = min ask = 50.
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'ed000002-0000-0000-0000-000000000002'),
  '50.00', 'E2 FMV falls back to the min ask under the ceiling');

-- E3: ask above the $5000 ceiling with no FMV → NO row written.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots WHERE edition_id = 'ed000003-0000-0000-0000-000000000003'),
  '0', 'E3 above the ask ceiling writes nothing (no $1M garbage)');

-- E4: already HIGH → untouched, still exactly its one HIGH row, no ASK_ONLY added.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots WHERE edition_id = 'ed000004-0000-0000-0000-000000000004'),
  '1', 'E4 keeps exactly its HIGH row');
SELECT _assert_eq((SELECT confidence::text FROM fmv_snapshots WHERE edition_id = 'ed000004-0000-0000-0000-000000000004'),
  'HIGH', 'E4 HIGH row is never overwritten by an ASK_ONLY derivation');

SELECT '✓ fmv_from_cached_listings invariants pass' AS result;
ROLLBACK;
