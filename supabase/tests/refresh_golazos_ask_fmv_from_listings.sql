-- DB invariant: public.refresh_golazos_ask_fmv_from_listings — the LaLiga Golazos
-- ASK_ONLY lane, priced from the on-chain listing book (cached_listings_v2, kept by
-- golazos-storefront-reconcile). Pins: FMV = 90% of the cheapest FRESH live ask and
-- the ask is the floor; STALE/NO_DATA editions are rescued; a sales-backed row is never
-- touched; a Flowty-derived ASK_ONLY row (ask_only_v2*) moves onto the book; the lane's
-- own row tracks a moved floor; an ASK_ONLY row from another writer that sits below the
-- ask is left alone; a listing that is unverified (> 6 h), closed, or not from the V2
-- storefront prices nothing; and the run logs what it did, including the unverified count.
-- DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260925224605_audit_20260925_golazos_ask_fmv_moves_off_flowty_onto_the_onchain_book.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE fmv_confidence AS ENUM ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

CREATE TABLE cached_listings_v2 (
  listing_resource_id bigint, source text, edition_id uuid, collection_id uuid,
  price_usd numeric, listed_at timestamptz, expiry_at timestamptz,
  completed_at timestamptz, verified_at timestamptz);
CREATE TABLE fmv_snapshots (
  id bigserial PRIMARY KEY, edition_id uuid, collection_id uuid, fmv_usd numeric,
  floor_price_usd numeric, asp_usd numeric, ask_proxy_fmv numeric, cross_market_ask numeric,
  confidence fmv_confidence, listing_count int, algo_version text,
  computed_at timestamptz DEFAULT now(), collection text, sales_count_7d int, sales_count_30d int);
CREATE TABLE pipeline_runs (
  pipeline text, collection_slug text, ok boolean, started_at timestamptz, finished_at timestamptz,
  rows_found int, rows_written int, extra jsonb);

-- >>> BEGIN verbatim refresh_golazos_ask_fmv_from_listings (byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.refresh_golazos_ask_fmv_from_listings()
 RETURNS TABLE(rescued integer, considered integer)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_coll        uuid := '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid;
  v_ceiling     numeric := 10000;
  -- A listing counts only if golazos-storefront-reconcile (every 2 h) confirmed it
  -- within this window, or the event indexer saw it listed within it. Three missed
  -- reconcile runs and the book stops pricing instead of re-publishing itself.
  v_max_age     interval := interval '6 hours';
  v_today_start timestamptz := date_trunc('day', now());
  v_today_end   timestamptz := date_trunc('day', now()) + interval '1 day';
  v_rescued     int := 0;
  v_considered  int := 0;
  v_recapped    int := 0;
  v_off_flowty  int := 0;
  v_tracked     int := 0;
  v_unverified  int := 0;
  v_started     timestamptz := clock_timestamp();
BEGIN
  DROP TABLE IF EXISTS _gz_ask;
  CREATE TEMP TABLE _gz_ask ON COMMIT DROP AS
  SELECT cl.edition_id, MIN(cl.price_usd) AS low_ask, COUNT(*)::int AS n
  FROM cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.edition_id IS NOT NULL
    AND cl.source IN ('direct_v2', 'storefront_v2')
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
    AND COALESCE(cl.verified_at, cl.listed_at) > now() - v_max_age
  GROUP BY cl.edition_id;

  -- Open listings excluded ONLY for being unconfirmed — reported so a stalled
  -- reconciler reads as a stalled reconciler, not as a quiet market.
  SELECT count(*) INTO v_unverified
  FROM cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.edition_id IS NOT NULL
    AND cl.source IN ('direct_v2', 'storefront_v2')
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
    AND COALESCE(cl.verified_at, cl.listed_at, '-infinity'::timestamptz) <= now() - v_max_age;

  -- Which editions to (re)price. Never a sales-backed HIGH/MEDIUM/LOW row.
  --   STALE / NO_DATA                  → rescue from the live ask
  --   ASK_ONLY above the live ask      → re-cap (the ask-ceiling rule)
  --   ASK_ONLY from Flowty (ask_only_v2*) → move onto the on-chain book
  --   this lane's own row, floor moved → track the floor both ways
  DROP TABLE IF EXISTS _gz_targets;
  CREATE TEMP TABLE _gz_targets ON COMMIT DROP AS
  SELECT a.edition_id, a.low_ask, a.n, latest.conf, latest.algo, latest.fmv
  FROM _gz_ask a
  JOIN LATERAL (
    SELECT fs.confidence::text AS conf, fs.fmv_usd AS fmv, fs.algo_version AS algo
    FROM fmv_snapshots fs
    WHERE fs.edition_id = a.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE latest.conf IN ('STALE', 'NO_DATA')
     OR (latest.conf = 'ASK_ONLY' AND latest.fmv > a.low_ask)
     OR (latest.conf = 'ASK_ONLY' AND latest.algo LIKE 'ask_only_v2%')
     OR (latest.conf = 'ASK_ONLY' AND latest.algo = 'golazos-listing-ask-v1'
         AND abs(latest.fmv - round(a.low_ask * 0.90, 2)) >= 0.01);

  v_considered := (SELECT count(*) FROM _gz_targets);
  v_recapped   := (SELECT count(*) FROM _gz_targets WHERE conf = 'ASK_ONLY' AND fmv > low_ask);
  v_off_flowty := (SELECT count(*) FROM _gz_targets WHERE algo LIKE 'ask_only_v2%');
  v_tracked    := (SELECT count(*) FROM _gz_targets WHERE algo = 'golazos-listing-ask-v1');

  IF v_considered > 0 THEN
    -- Today's non-sales rows only: a sales-backed row is never deleted here.
    DELETE FROM fmv_snapshots fs
    USING _gz_targets t
    WHERE fs.edition_id    = t.edition_id
      AND fs.collection_id = v_coll
      AND fs.computed_at  >= v_today_start
      AND fs.computed_at  <  v_today_end
      AND fs.confidence IN ('STALE'::fmv_confidence, 'NO_DATA'::fmv_confidence, 'ASK_ONLY'::fmv_confidence);

    -- Same shape as the All Day lane (allday-listing-ask-v1): FMV 90% of the
    -- cheapest live ask, the ask itself recorded as the floor. FMV != floor, so the
    -- thin-sale haircut (which only touches fmv ≈ floor) does not cut it again.
    INSERT INTO fmv_snapshots (
      edition_id, collection_id, fmv_usd, floor_price_usd,
      asp_usd, ask_proxy_fmv, cross_market_ask,
      confidence, listing_count, algo_version, computed_at, collection,
      sales_count_7d, sales_count_30d
    )
    SELECT
      t.edition_id, v_coll,
      round(t.low_ask * 0.90, 2), round(t.low_ask, 2),
      round(t.low_ask * 0.90, 2), round(t.low_ask * 0.90, 2), round(t.low_ask, 2),
      'ASK_ONLY'::fmv_confidence, t.n, 'golazos-listing-ask-v1', now(), 'laliga_golazos',
      0, 0
    FROM _gz_targets t;
    GET DIAGNOSTICS v_rescued = ROW_COUNT;
  END IF;

  INSERT INTO pipeline_runs (pipeline, collection_slug, ok, started_at, finished_at, rows_found, rows_written, extra)
  VALUES ('golazos-listing-ask-fmv', 'laliga_golazos', true, v_started, clock_timestamp(), v_considered, v_rescued,
          jsonb_build_object('priced', v_rescued, 'considered', v_considered,
                             'editions_with_fresh_ask', (SELECT count(*) FROM _gz_ask),
                             'recapped_above_live_ask', v_recapped,
                             'moved_off_flowty', v_off_flowty,
                             'tracked_floor_change', v_tracked,
                             'open_listings_unverified', v_unverified));

  RETURN QUERY SELECT v_rescued, v_considered;
END;
$function$;
-- <<< END verbatim refresh_golazos_ask_fmv_from_listings <<<

DO $seed$
DECLARE
  gz uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  g1 uuid := 'a0000001-0000-0000-0000-000000000001';
  g2 uuid := 'a0000002-0000-0000-0000-000000000002';
  g3 uuid := 'a0000003-0000-0000-0000-000000000003';
  g4 uuid := 'a0000004-0000-0000-0000-000000000004';
  g5 uuid := 'a0000005-0000-0000-0000-000000000005';
  g6 uuid := 'a0000006-0000-0000-0000-000000000006';
  g7 uuid := 'a0000007-0000-0000-0000-000000000007';
  g8 uuid := 'a0000008-0000-0000-0000-000000000008';
BEGIN
  -- G1: STALE, two fresh listings 10 (verified) and 12 (verified) → rescued at 9.00, floor 10, 2 listings.
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version) VALUES (g1,gz,40,'STALE','1.7.0');
  INSERT INTO cached_listings_v2 VALUES (1,'storefront_v2',g1,gz,10,NULL,NULL,NULL,now()), (2,'direct_v2',g1,gz,12,now()-interval '30 days',NULL,NULL,now());
  -- G2: sales-backed HIGH → never touched even with a live ask below it.
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version) VALUES (g2,gz,20,'HIGH','1.7.0');
  INSERT INTO cached_listings_v2 VALUES (3,'storefront_v2',g2,gz,5,NULL,NULL,NULL,now());
  -- G3: Flowty-derived ASK_ONLY (haircut label) BELOW the ask → still moved onto the book.
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version) VALUES (g3,gz,2.2,'ASK_ONLY','ask_only_v2_haircut');
  INSERT INTO cached_listings_v2 VALUES (4,'storefront_v2',g3,gz,4,NULL,NULL,NULL,now());
  -- G4: STALE, but its only listing was last confirmed 7 h ago and listed 8 h ago → not priced.
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version) VALUES (g4,gz,40,'STALE','1.7.0');
  INSERT INTO cached_listings_v2 VALUES (5,'direct_v2',g4,gz,6,now()-interval '8 hours',NULL,NULL,now()-interval '7 hours');
  -- G5: this lane's own row at 9.00; the floor fell to 8 → re-priced to 7.20.
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, algo_version) VALUES (g5,gz,9,10,'ASK_ONLY','golazos-listing-ask-v1');
  INSERT INTO cached_listings_v2 VALUES (6,'storefront_v2',g5,gz,8,NULL,NULL,NULL,now());
  -- G6: another writer's ASK_ONLY at 2, BELOW the live ask of 5 → left alone.
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version) VALUES (g6,gz,2,'ASK_ONLY','1.7.0');
  INSERT INTO cached_listings_v2 VALUES (7,'storefront_v2',g6,gz,5,NULL,NULL,NULL,now());
  -- G7: STALE, only listing closed (ghosted) → not priced.
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version) VALUES (g7,gz,40,'STALE','1.7.0');
  INSERT INTO cached_listings_v2 VALUES (8,'storefront_v2',g7,gz,3,NULL,NULL,now(),now());
  -- G8: STALE, only listing from the V1 storefront → out of scope, not priced.
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version) VALUES (g8,gz,40,'STALE','1.7.0');
  INSERT INTO cached_listings_v2 VALUES (9,'direct_v1',g8,gz,3,now(),NULL,NULL,NULL);
END $seed$;

SELECT _assert_eq((SELECT rescued::text || '/' || considered::text FROM refresh_golazos_ask_fmv_from_listings()),
  '3/3', 'prices exactly G1 (rescue), G3 (off Flowty), G5 (floor moved)');

SELECT _assert_eq((SELECT string_agg(confidence::text || ':' || fmv_usd::text || ':' || floor_price_usd::text || ':' || listing_count::text || ':' || algo_version, ',') FROM fmv_snapshots WHERE edition_id = 'a0000001-0000-0000-0000-000000000001'),
  'ASK_ONLY:9.00:10.00:2:golazos-listing-ask-v1', 'G1 rescued: FMV 90% of the cheapest fresh ask, floor = ask, today''s STALE row replaced');
SELECT _assert_eq((SELECT string_agg(confidence::text || ':' || fmv_usd::text, ',') FROM fmv_snapshots WHERE edition_id = 'a0000002-0000-0000-0000-000000000002'),
  'HIGH:20', 'G2 sales-backed HIGH untouched');
SELECT _assert_eq((SELECT string_agg(fmv_usd::text || ':' || algo_version, ',') FROM fmv_snapshots WHERE edition_id = 'a0000003-0000-0000-0000-000000000003'),
  '3.60:golazos-listing-ask-v1', 'G3 Flowty-derived ASK_ONLY moved onto the on-chain book');
SELECT _assert_eq((SELECT string_agg(confidence::text || ':' || fmv_usd::text, ',') FROM fmv_snapshots WHERE edition_id = 'a0000004-0000-0000-0000-000000000004'),
  'STALE:40', 'G4 unverified listing (> 6 h) prices nothing');
SELECT _assert_eq((SELECT string_agg(fmv_usd::text || ':' || floor_price_usd::text, ',') FROM fmv_snapshots WHERE edition_id = 'a0000005-0000-0000-0000-000000000005'),
  '7.20:8.00', 'G5 the lane''s own row tracks a moved floor');
SELECT _assert_eq((SELECT string_agg(fmv_usd::text || ':' || algo_version, ',') FROM fmv_snapshots WHERE edition_id = 'a0000006-0000-0000-0000-000000000006'),
  '2:1.7.0', 'G6 another writer''s ASK_ONLY below the ask is left alone');
SELECT _assert_eq((SELECT string_agg(confidence::text, ',') FROM fmv_snapshots WHERE edition_id = 'a0000007-0000-0000-0000-000000000007'),
  'STALE', 'G7 a closed listing prices nothing');
SELECT _assert_eq((SELECT string_agg(confidence::text, ',') FROM fmv_snapshots WHERE edition_id = 'a0000008-0000-0000-0000-000000000008'),
  'STALE', 'G8 a V1-storefront listing is out of scope');

SELECT _assert_eq((SELECT pipeline || ':' || ok::text || ':' || rows_written::text || ':' || (extra->>'moved_off_flowty') || ':' || (extra->>'tracked_floor_change') || ':' || (extra->>'open_listings_unverified') FROM pipeline_runs),
  'golazos-listing-ask-fmv:true:3:1:1:1', 'the run logs priced / moved-off-Flowty / tracked / unverified counts');

SELECT '✓ refresh_golazos_ask_fmv_from_listings invariants pass' AS result;
ROLLBACK;
