-- DB invariant: public.fmv_from_cached_listings — derives ASK_ONLY FMV rows from
-- the Flowty listing cache for editions that have no sales-backed (HIGH/MEDIUM/LOW)
-- FMV. It prefers the average of Flowty's own pre-computed FMV, CAPPED at the
-- cheapest ask under a $5000 sanity ceiling (2026-09-23: the ask-ceiling rule),
-- falls back to that ask when there is no FMV, records no floor above the ceiling
-- (no $1M troll floors), replaces only its own ASK_ONLY rows, never touches an
-- edition with a sales-backed row, and prices nothing for NFL All Day (owned by the
-- ghost-aware writers since 2026-09-23). Since 2026-09-25 it prices only from listings
-- the cache fetched within 2 hours, so a frozen cache (Flowty sweeps failing, prior
-- cache preserved) is never re-stamped as fresh FMV.
-- DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260925152928_audit_20260925_fmv_from_cached_listings_prices_only_fresh_listings.sql);
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
  player_name text, set_name text, ask_price numeric, fmv numeric,
  cached_at timestamptz DEFAULT now());
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
  -- 2026-09-25: only listings the cache fetched within this window are priced. When
  -- Flowty's API stops answering, every listing-cache sweep fails and the route keeps
  -- its prior cache (right for a blip), so without this bound the lane re-stamped
  -- those frozen asks as fresh ASK_ONLY rows (computed_at = NOW()) every 20 minutes
  -- until the daily 48 h purge emptied the cache. A stale listing now neither deletes
  -- nor re-writes: the edition keeps its last row, whose computed_at ages honestly.
  -- 2 h = six missed 20-minute ticks, so a short upstream blip changes nothing.
  listing_max_age interval := interval '2 hours';
BEGIN
  -- 2026-09-23: NFL All Day is NOT priced here. Its ASK_ONLY lane is owned by
  -- fmv-recalc Step 5d and refresh_allday_ask_fmv_from_listings, both of which read
  -- the on-chain listings (cached_listings_v2) through the ghost filter
  -- (allday_listings_sold_after_listing). The Flowty cache this function reads held
  -- mostly $1,000,000 troll asks for All Day, and publishing Flowty's valuation over
  -- them put FMVs 20x above a live buy-it-now (Jer'Zhan Newton $60.39 vs a $3 ask) and
  -- re-created prices the ghost fix had just retired.
  IF p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN
    RETURN 0;
  END IF;

  -- Targeted DELETE: only this lane's own ASK_ONLY rows. It used to delete LOW rows
  -- too, which let a Flowty valuation replace a sales-derived LOW price.
  DELETE FROM fmv_snapshots fs
  WHERE fs.collection_id = p_collection_id
    AND fs.confidence = 'ASK_ONLY'::fmv_confidence
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
        AND cl.cached_at > NOW() - listing_max_age
        AND NOT EXISTS (
          SELECT 1 FROM fmv_snapshots f2
          WHERE f2.edition_id = e.id
            AND f2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence)
        )
    );

  -- INSERT new ASK_ONLY rows. The valuation is capped at the cheapest ask under the
  -- sanity ceiling (the ask-ceiling rule: a base FMV above buy-it-now is a confident
  -- wrong number), and an ask above the ceiling is never recorded as a floor.
  INSERT INTO fmv_snapshots (
    edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
    confidence, listing_count, algo_version, computed_at,
    liquidity_rating, top_shot_ask, flowty_ask, cross_market_ask
  )
  SELECT
    e.id AS edition_id,
    p_collection_id,
    -- Primary: avg of cl.fmv when present; fallback: MIN(ask_price) under the ceiling.
    -- LEAST ignores NULLs, so an ask above the ceiling simply does not cap.
    LEAST(
      COALESCE(
        NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
        CASE
          WHEN MIN(cl.ask_price) <= ask_price_ceiling
          THEN ROUND(MIN(cl.ask_price), 2)
          ELSE NULL  -- no FMV row produced — better silence than $1M garbage
        END
      ),
      CASE
        WHEN MIN(cl.ask_price) <= ask_price_ceiling
        THEN ROUND(MIN(cl.ask_price), 2)
        ELSE NULL
      END
    ) AS fmv_usd,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS floor_price_usd,
    NULL AS wap_usd,
    'ASK_ONLY'::fmv_confidence AS confidence,
    COUNT(cl.id)::int AS listing_count,
    p_algo_version,
    NOW(),
    1 AS liquidity_rating,
    NULL AS top_shot_ask,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS flowty_ask,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS cross_market_ask
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
    AND cl.cached_at > NOW() - listing_max_age
    AND NOT EXISTS (
      SELECT 1 FROM fmv_snapshots fs2
      WHERE fs2.edition_id = e.id
        AND fs2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence)
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
  e5 uuid := 'ed000005-0000-0000-0000-000000000005';
  e6 uuid := 'ed000006-0000-0000-0000-000000000006';
  e7 uuid := 'ed000007-0000-0000-0000-000000000007';
  e8 uuid := 'ed000008-0000-0000-0000-000000000008';
  e9 uuid := 'ed000009-0000-0000-0000-000000000009';
  e10 uuid := 'ed000010-0000-0000-0000-000000000010';
  ad uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'; -- nfl_all_day
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

  INSERT INTO editions (id, collection_id, external_id, player_name, set_name) VALUES
    (e5,c,'M5','P5','S5'),(e6,c,'M6','P6','S6'),(e7,c,'M7','P7','S7'),(e8,ad,'M8','P8','S8');

  -- E5: matched BUT already has a sales-backed LOW row → untouched (not deleted, no ASK_ONLY added)
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv) VALUES
    (c,'M5','P5','S5',20,18);
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version)
    VALUES (e5,c,7,'LOW','1.7.0');

  -- E6: Flowty FMV 60 above the cheapest ask 3 → capped at the ask (3)
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv) VALUES
    (c,'M6','P6','S6',3,60);

  -- E7: Flowty FMV 12 over a $1,000,000 troll ask → FMV 12, floor NOT recorded
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv) VALUES
    (c,'M7','P7','S7',1000000,12);

  -- E8: NFL All Day edition → never priced here, prior row untouched
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv) VALUES
    (ad,'M8','P8','S8',1000000,60);
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version)
    VALUES (e8,ad,NULL,'NO_DATA','allday-ask-retired-v1');

  INSERT INTO editions (id, collection_id, external_id, player_name, set_name) VALUES
    (e9,c,'M9','P9','S9'),(e10,c,'M10','P10','S10');

  -- E9: only a STALE listing (cached 3 h ago — the frozen-cache shape once Flowty's
  -- sweeps stop landing) and a prior ASK_ONLY row → the prior row is neither deleted
  -- nor re-stamped; its computed_at keeps aging.
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv, cached_at) VALUES
    (c,'M9','P9','S9',9,9, now() - interval '3 hours');
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version, computed_at)
    VALUES (e9,c,42,'ASK_ONLY','ask_only_v2', '2026-01-01T12:00:00Z');

  -- E10: one fresh listing (ask 8) and one stale cheaper one (ask 2) → the stale ask
  -- neither caps the FMV nor becomes the floor.
  INSERT INTO cached_listings (collection_id, moment_id, player_name, set_name, ask_price, fmv, cached_at) VALUES
    (c,'M10','P10','S10',8,NULL, now()),
    (c,'M10','P10','S10',2,NULL, now() - interval '3 hours');
END $seed$;

-- Returns the count of ASK_ONLY rows written: E1 (replace) + E2 (ask fallback) + E6 + E7 + E10 = 5.
-- E9 (stale listing only) is NOT among them.
SELECT _assert_eq(
  (fmv_from_cached_listings('06248cc4-b85f-47cd-af67-1855d14acd75'::uuid))::text,
  '5', 'writes 5 ASK_ONLY rows (E1 avg-FMV + E2 ask-fallback + E6 capped + E7 troll-floor + E10 fresh-only)');

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

-- E5: a sales-backed LOW row is neither deleted nor shadowed by an ASK_ONLY row.
SELECT _assert_eq((SELECT string_agg(confidence::text || ':' || fmv_usd::text, ',') FROM fmv_snapshots WHERE edition_id = 'ed000005-0000-0000-0000-000000000005'),
  'LOW:7', 'E5 keeps its sales-backed LOW row and gets no ASK_ONLY row');

-- E6: the Flowty valuation is capped at the cheapest ask (ask-ceiling rule).
SELECT _assert_eq((SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'ed000006-0000-0000-0000-000000000006'),
  '3.00', 'E6 FMV capped at the cheapest ask, not Flowty 60');

-- E7: a $1M troll ask never becomes a recorded floor, and does not cap.
SELECT _assert_eq((SELECT fmv_usd::text || '|' || coalesce(floor_price_usd::text,'null') || '|' || coalesce(flowty_ask::text,'null') FROM fmv_snapshots WHERE edition_id = 'ed000007-0000-0000-0000-000000000007'),
  '12.00|null|null', 'E7 FMV 12 with no $1M floor recorded');

-- E8: NFL All Day is not priced here at all.
SELECT _assert_eq((fmv_from_cached_listings('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid))::text,
  '0', 'All Day call writes nothing');
SELECT _assert_eq((SELECT string_agg(confidence::text || ':' || algo_version, ',') FROM fmv_snapshots WHERE edition_id = 'ed000008-0000-0000-0000-000000000008'),
  'NO_DATA:allday-ask-retired-v1', 'E8 All Day retired row untouched');

-- E9: a stale listing neither deletes nor re-stamps the edition's prior row.
SELECT _assert_eq((SELECT string_agg(fmv_usd::text || '|' || computed_at::date::text, ',') FROM fmv_snapshots WHERE edition_id = 'ed000009-0000-0000-0000-000000000009'),
  '42|2026-01-01', 'E9 prior ASK_ONLY row untouched: a frozen listing is not re-stamped as fresh FMV');

-- E10: priced from the fresh listing only.
SELECT _assert_eq((SELECT fmv_usd::text || '|' || floor_price_usd::text || '|' || listing_count::text FROM fmv_snapshots WHERE edition_id = 'ed000010-0000-0000-0000-000000000010'),
  '8.00|8.00|1', 'E10 stale cheaper ask ignored: FMV and floor from the fresh listing only');

SELECT '✓ fmv_from_cached_listings invariants pass' AS result;
ROLLBACK;
