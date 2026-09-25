-- DB invariant: public.refresh_allday_ask_fmv_from_listings — the AllDay ASK-FMV
-- RESCUE writer. For AllDay editions whose latest FMV is STALE or NO_DATA (i.e. no
-- usable sales-derived price), it derives an ASK_ONLY placeholder from the live
-- listing floor so the edition shows *something* instead of "no data". The gates:
-- only STALE/NO_DATA editions are rescued (a HIGH/MEDIUM/LOW value is never
-- touched; an ASK_ONLY one only when it sits above the live ask, see below), only live listings count (price>0, <= $10,000 ceiling, not
-- completed, not expired), the low ask is the MIN across listings, the written
-- fmv is a 10% haircut off that ask, and it delete-then-inserts TODAY only. It
-- logs a pipeline_runs row and returns (rescued, considered).
--
-- ⚠ AND SINCE 2026-09-23, an ASK_ONLY price above today's live ask is re-capped.
-- An ASK_ONLY row is ask * 0.90 when written and nothing revisited it, so when a
-- cheaper listing arrived the published FMV sat above buy-it-now (26 All Day
-- editions, 8 h to 7 days old). The gate is now STALE/NO_DATA, OR ASK_ONLY with
-- fmv_usd > the live ask; an ASK_ONLY at or under the ask is left alone.
--
-- 🚨 AND SINCE 2026-09-22, A GHOST LISTING IS NOT A LIVE ASK. `completed_at IS
-- NULL` does NOT mean the NFT is still for sale: All Day leaves the listing row
-- open when the underlying NFT sells elsewhere, so 3,000 AllDay editions carried
-- at least one listing whose NFT had already sold, and 182 had ONLY such
-- listings. The floor view learned to exclude them that afternoon
-- (20260922205752) — but THIS function read `cached_listings_v2` directly and
-- so went on pricing editions off dead listings every 6 hours, re-creating from
-- the write side exactly what the read side had just fixed. It now anti-joins
-- `allday_listings_sold_after_listing`, the single source of ghost truth, and
-- reports `ghost_only_editions_skipped` so the editions it REFUSES to price are
-- counted rather than silent.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260925231149_audit_20260925_allday_ask_lane_tracks_its_own_floor_both_ways.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM
  ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

CREATE TABLE public.cached_listings_v2 (
  edition_id          uuid,
  collection_id       uuid,
  price_usd           numeric,
  completed_at        timestamptz,
  expiry_at           timestamptz,
  listing_resource_id text,
  source              text
);
-- The ghost set: listings whose NFT sold AFTER the listing was created. Refreshed
-- in prod by pg_cron job 596; here it is just a set the function must subtract.
CREATE TABLE public.allday_listings_sold_after_listing (
  listing_resource_id text,
  source              text
);
CREATE TABLE public.fmv_snapshots (
  edition_id       uuid,
  collection_id    uuid,
  fmv_usd          numeric,
  floor_price_usd  numeric,
  asp_usd          numeric,
  ask_proxy_fmv    numeric,
  cross_market_ask numeric,
  confidence       fmv_confidence,
  listing_count    integer,
  algo_version     text,
  computed_at      timestamptz,
  collection       text,
  sales_count_7d   integer,
  sales_count_30d  integer
);
CREATE TABLE public.pipeline_runs (
  pipeline    text,
  ok          boolean,
  started_at  timestamptz,
  finished_at timestamptz,
  extra       jsonb
);

-- >>> BEGIN verbatim refresh_allday_ask_fmv_from_listings (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_allday_ask_fmv_from_listings()
RETURNS TABLE(rescued integer, considered integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_coll        uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;
  v_ceiling     numeric := 10000;
  v_today_start timestamptz := date_trunc('day', now());
  v_today_end   timestamptz := date_trunc('day', now()) + interval '1 day';
  v_rescued     int := 0;
  v_considered  int := 0;
  v_recapped    int := 0;
  v_ghost_skip  int := 0;
  v_tracked     int := 0;
  v_started     timestamptz := clock_timestamp();
BEGIN
  DROP TABLE IF EXISTS _ad_ask;
  CREATE TEMP TABLE _ad_ask ON COMMIT DROP AS
  SELECT cl.edition_id, MIN(cl.price_usd) AS low_ask
  FROM cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
    AND NOT EXISTS (
      SELECT 1 FROM allday_listings_sold_after_listing g
      WHERE g.listing_resource_id = cl.listing_resource_id
        AND g.source = cl.source
    )
  GROUP BY cl.edition_id;

  SELECT count(DISTINCT cl.edition_id) INTO v_ghost_skip
  FROM cached_listings_v2 cl
  JOIN allday_listings_sold_after_listing g
    ON g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source
  WHERE cl.collection_id = v_coll
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
    AND NOT EXISTS (SELECT 1 FROM _ad_ask a WHERE a.edition_id = cl.edition_id);

  DROP TABLE IF EXISTS _ad_targets;
  CREATE TEMP TABLE _ad_targets ON COMMIT DROP AS
  SELECT a.edition_id, a.low_ask, latest.conf, latest.fmv, latest.algo
  FROM _ad_ask a
  JOIN LATERAL (
    SELECT fs.confidence::text AS conf, fs.fmv_usd AS fmv, fs.algo_version AS algo
    FROM fmv_snapshots fs
    WHERE fs.edition_id = a.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE latest.conf IN ('STALE','NO_DATA')
     OR (latest.conf = 'ASK_ONLY' AND latest.fmv > a.low_ask)
     -- 2026-09-25: this lane's OWN rows follow the live floor in BOTH directions.
     -- Re-capping only downward left a price stranded below the market once its
     -- cheapest listing sold — and 27,406 unpurchasable Flowty-fork listings closed
     -- the same day had set exactly such floors.
     OR (latest.conf = 'ASK_ONLY' AND latest.algo = 'allday-listing-ask-v1'
         AND abs(latest.fmv - round(a.low_ask * 0.90, 2)) >= 0.01);

  v_considered := (SELECT count(*) FROM _ad_targets);
  v_recapped   := (SELECT count(*) FROM _ad_targets WHERE conf = 'ASK_ONLY' AND fmv > low_ask);
  v_tracked    := (SELECT count(*) FROM _ad_targets WHERE algo = 'allday-listing-ask-v1');

  IF v_considered > 0 THEN
    DELETE FROM fmv_snapshots fs
    USING _ad_targets t
    WHERE fs.edition_id   = t.edition_id
      AND fs.collection_id = v_coll
      AND fs.computed_at  >= v_today_start
      AND fs.computed_at  <  v_today_end;

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
      'ASK_ONLY'::fmv_confidence, NULL, 'allday-listing-ask-v1', now(), 'nfl_all_day',
      0, 0
    FROM _ad_targets t;
    GET DIAGNOSTICS v_rescued = ROW_COUNT;
  END IF;

  INSERT INTO pipeline_runs (pipeline, ok, started_at, finished_at, extra)
  VALUES ('allday-listing-ask-fmv', true, v_started, clock_timestamp(),
          jsonb_build_object('rescued', v_rescued, 'considered', v_considered,
                             'recapped_above_live_ask', v_recapped,
                             'ghost_only_editions_skipped', v_ghost_skip,
                             'tracked_floor_change', v_tracked));

  RETURN QUERY SELECT v_rescued, v_considered;
END;
$fn$;
-- <<< END verbatim refresh_allday_ask_fmv_from_listings <<<

\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set eStale   '''e0000000-0000-0000-0000-0000000000a1'''
\set eNoData  '''e0000000-0000-0000-0000-0000000000a2'''
\set eHigh    '''e0000000-0000-0000-0000-0000000000a3'''
\set eCeiling '''e0000000-0000-0000-0000-0000000000a4'''
\set eDone    '''e0000000-0000-0000-0000-0000000000a5'''
\set eGhost   '''e0000000-0000-0000-0000-0000000000a6'''
\set eMixed   '''e0000000-0000-0000-0000-0000000000a7'''
\set eAskHigh '''e0000000-0000-0000-0000-0000000000a8'''
\set eAskOk   '''e0000000-0000-0000-0000-0000000000a9'''
\set eOwnUp   '''e0000000-0000-0000-0000-0000000000aa'''
\set eOwnSame '''e0000000-0000-0000-0000-0000000000ab'''

-- Listings: eStale has two (MIN 100 wins), eNoData one (50), eHigh one (60),
-- eCeiling one ABOVE the $10k ceiling (ignored), eDone one but completed (ignored).
-- eGhost's ONLY listing is a ghost (its NFT already sold) - it must not be priced.
-- eMixed has a CHEAPER ghost (10) and a real ask (70): the ghost must not set the
-- floor, which is the whole point - a ghost is how an edition gets a price below
-- everything the market actually clears at.
INSERT INTO public.cached_listings_v2
  (edition_id, collection_id, price_usd, completed_at, expiry_at, listing_resource_id, source) VALUES
  (:eStale::uuid,   :ad::uuid,   200, NULL,  NULL,                      'L1', 'dapper'),
  (:eStale::uuid,   :ad::uuid,   100, NULL,  now() + interval '1 day',  'L2', 'dapper'),
  (:eNoData::uuid,  :ad::uuid,    50, NULL,  NULL,                      'L3', 'dapper'),
  (:eHigh::uuid,    :ad::uuid,    60, NULL,  NULL,                      'L4', 'dapper'),
  (:eCeiling::uuid, :ad::uuid, 20000, NULL,  NULL,                      'L5', 'dapper'),
  (:eDone::uuid,    :ad::uuid,    40, now(), NULL,                      'L6', 'dapper'),
  (:eGhost::uuid,   :ad::uuid,    30, NULL,  NULL,                      'L7', 'dapper'),
  (:eMixed::uuid,   :ad::uuid,    10, NULL,  NULL,                      'L8', 'dapper'),
  (:eMixed::uuid,   :ad::uuid,    70, NULL,  NULL,                      'L9', 'dapper'),
  (:eAskHigh::uuid, :ad::uuid,    50, NULL,  NULL,                      'L10', 'dapper'),
  (:eAskOk::uuid,   :ad::uuid,    50, NULL,  NULL,                      'L11', 'dapper'),
  (:eOwnUp::uuid,   :ad::uuid,    80, NULL,  NULL,                      'L12', 'dapper'),
  (:eOwnSame::uuid, :ad::uuid,    50, NULL,  NULL,                      'L13', 'dapper');

INSERT INTO public.allday_listings_sold_after_listing (listing_resource_id, source) VALUES
  ('L7', 'dapper'),   -- eGhost's only listing
  ('L8', 'dapper');   -- eMixed's CHEAPER listing

-- Latest snapshot per edition sets the rescue gate. eStale also has a YESTERDAY
-- row that must survive the today-only delete.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, computed_at, collection) VALUES
  (:eStale::uuid,   :ad::uuid, 'STALE',   date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  (:eStale::uuid,   :ad::uuid, 'ASK_ONLY',date_trunc('day', now()) - interval '3 hours', 'nfl_all_day'),
  (:eNoData::uuid,  :ad::uuid, 'NO_DATA', date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  (:eHigh::uuid,    :ad::uuid, 'HIGH',    date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  (:eCeiling::uuid, :ad::uuid, 'STALE',   date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  (:eGhost::uuid,   :ad::uuid, 'STALE',   date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  (:eMixed::uuid,   :ad::uuid, 'STALE',   date_trunc('day', now()) + interval '1 hour', 'nfl_all_day');

-- eAskHigh: an ASK_ONLY price of 90 written days ago, and the live ask is now 50.
-- It must be re-capped to 45. eAskOk: ASK_ONLY 40 under a live 50 - left alone.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at, collection) VALUES
  (:eAskHigh::uuid, :ad::uuid, 90, 'ASK_ONLY', date_trunc('day', now()) - interval '3 days', 'nfl_all_day'),
  (:eAskOk::uuid,   :ad::uuid, 40, 'ASK_ONLY', date_trunc('day', now()) - interval '3 days', 'nfl_all_day');

-- 2026-09-25: this lane's OWN rows track the floor both ways. eOwnUp was priced at
-- 45 off a floor of 50 that has since RISEN to 80 → re-derived to 72. eOwnSame is
-- still 45 on a floor of 50 → untouched (no churn). An ASK_ONLY row from another
-- writer below the ask (eAskOk, algo NULL) keeps the old rule and is left alone.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version, computed_at, collection) VALUES
  (:eOwnUp::uuid,   :ad::uuid, 45, 'ASK_ONLY', 'allday-listing-ask-v1', date_trunc('day', now()) - interval '2 days', 'nfl_all_day'),
  (:eOwnSame::uuid, :ad::uuid, 45, 'ASK_ONLY', 'allday-listing-ask-v1', date_trunc('day', now()) - interval '2 days', 'nfl_all_day');

CREATE TEMP TABLE _r AS SELECT * FROM public.refresh_allday_ask_fmv_from_listings();

-- -- Return tuple (rescued, considered) = (4, 4): eStale + eNoData + eMixed + eAskHigh
SELECT _assert_eq((SELECT rescued::text FROM _r),    '5', 'rescued = eStale + eNoData + eMixed (STALE/NO_DATA with a live NON-GHOST ask) + eAskHigh (ASK_ONLY above it) + eOwnUp (own row, floor rose)');
SELECT _assert_eq((SELECT considered::text FROM _r), '5', 'considered = the same five - HIGH/ceiling/completed/ghost-only/at-or-under-ask/own-row-unchanged never enter');

-- -- THIS LANE'S OWN ROW FOLLOWS A RISING FLOOR (45 on 50 → 72 on 80) ---------
SELECT _assert_eq((SELECT fmv_usd::text || '|' || floor_price_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eOwnUp::uuid ORDER BY computed_at DESC LIMIT 1), '72.00|80.00',
  'an own-lane price is re-derived UP when its floor rises - it is not stranded below the market');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id=:eOwnSame::uuid), '1',
  'an own-lane price already at 90% of the floor gets no new row (no churn)');
SELECT _assert_eq((SELECT (extra->>'tracked_floor_change') FROM public.pipeline_runs
  WHERE pipeline='allday-listing-ask-fmv'), '1',
  'own-lane re-derivations are counted separately');

-- -- AN ASK_ONLY PRICE ABOVE THE LIVE ASK IS RE-CAPPED (90 over a live 50 -> 45) ---
SELECT _assert_eq((SELECT fmv_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eAskHigh::uuid AND computed_at >= date_trunc('day', now())), '45.00',
  'an ASK_ONLY price above buy-it-now is re-priced at the live ask * 0.90');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eAskHigh::uuid ORDER BY computed_at DESC LIMIT 1), '45.00',
  'and the re-capped row is the LATEST one, which is what the surface publishes');
-- -- ...but one at or under the ask is left alone (no churn) -----------------
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id=:eAskOk::uuid), '1',
  'an ASK_ONLY price at or under the live ask gets no new row');
SELECT _assert_eq((SELECT (extra->>'recapped_above_live_ask') FROM public.pipeline_runs
  WHERE pipeline='allday-listing-ask-fmv'), '1',
  'the re-capped editions are counted separately from rescues');

-- -- eStale: ASK_ONLY written, fmv = MIN ask (100) * 0.90 = 90, floor = 100 ----
SELECT _assert_eq((SELECT fmv_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eStale::uuid AND computed_at >= date_trunc('day', now())), '90.00',
  'fmv is a 10%% haircut off the MIN live ask (min(100,200)=100 -> 90.00)');
SELECT _assert_eq((SELECT floor_price_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eStale::uuid AND computed_at >= date_trunc('day', now())), '100.00',
  'the floor records the raw ask');
SELECT _assert_eq((SELECT confidence::text FROM public.fmv_snapshots
  WHERE edition_id=:eStale::uuid AND computed_at >= date_trunc('day', now())), 'ASK_ONLY',
  'a listing-derived rescue is graded ASK_ONLY');

-- -- A GHOST CANNOT SET THE FLOOR. eMixed prices off the REAL 70, not the dead
--    10 - this is the assertion that fails if the anti-join is ever removed. ---
SELECT _assert_eq((SELECT floor_price_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eMixed::uuid AND computed_at >= date_trunc('day', now())), '70.00',
  'a cheaper listing whose NFT already sold does NOT become the floor');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eMixed::uuid AND computed_at >= date_trunc('day', now())), '63.00',
  'fmv follows the real ask (70 -> 63.00), not the ghost (10 -> 9.00)');

-- -- An edition whose ONLY listing is a ghost gets NO price at all ------------
-- NB: assert on the ABSENCE OF THE ASK_ONLY ROW, not on "no row dated today".
-- eGhost is seeded with a STALE snapshot dated today (that is what makes it a
-- rescue candidate in the first place) and the function never deletes it,
-- because a non-target's rows are left alone. A today-dated NOT EXISTS here
-- would fail against correct behaviour.
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id=:eGhost::uuid AND confidence='ASK_ONLY'), '0',
  'a ghost-only edition gets no ASK_ONLY row - publishing nothing beats publishing a dead listing');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id=:eGhost::uuid), '1',
  'and its existing STALE row is left untouched - it is skipped, not rewritten');

-- -- and it is COUNTED, not silent -------------------------------------------
SELECT _assert_eq((SELECT (extra->>'ghost_only_editions_skipped') FROM public.pipeline_runs
  WHERE pipeline='allday-listing-ask-fmv'), '1',
  'the edition it refused to price is reported, so a rising skip count is visible');

-- -- delete-then-insert TODAY only: eStale keeps its yesterday row (2 total) --
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id=:eStale::uuid), '2',
  'the pre-today snapshot survives; only today was replaced');

-- -- eHigh is never touched (the rescue gate is STALE/NO_DATA only) -----------
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id=:eHigh::uuid), '1',
  'a HIGH edition gets no ASK_ONLY rescue row');

-- -- ceiling + completed editions never get a snapshot -----------------------
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id=:eCeiling::uuid AND confidence='ASK_ONLY'), '0',
  'an ask above the $10k ceiling is ignored - no rescue');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.fmv_snapshots WHERE edition_id=:eDone::uuid),
  'a completed listing yields no ask and no rescue');

-- -- the pipeline_runs audit row is written with the counts ------------------
SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs
  WHERE pipeline='allday-listing-ask-fmv' AND ok
    AND (extra->>'rescued')='5' AND (extra->>'considered')='5'), '1',
  'a pipeline_runs audit row records rescued/considered');

SELECT 'OK refresh_allday_ask_fmv_from_listings invariants pass' AS result;
ROLLBACK;
