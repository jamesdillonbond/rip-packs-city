-- DB invariant: public.refresh_allday_ask_fmv_from_listings — the AllDay ASK-FMV
-- RESCUE writer. For AllDay editions whose latest FMV is STALE or NO_DATA (i.e. no
-- usable sales-derived price), it derives an ASK_ONLY placeholder from the live
-- listing floor so the edition shows *something* instead of "no data". The gates:
-- only STALE/NO_DATA editions are rescued (a HIGH/MEDIUM/LOW/ASK_ONLY value is
-- never touched), only live listings count (price>0, <= $10,000 ceiling, not
-- completed, not expired), the low ask is the MIN across listings, the written
-- fmv is a 10% haircut off that ask, and it delete-then-inserts TODAY only. It
-- logs a pipeline_runs row and returns (rescued, considered).
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql),
-- verified byte-identical to live prod via pg_get_functiondef on 2026-07-31.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM
  ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

CREATE TABLE public.cached_listings_v2 (
  edition_id    uuid,
  collection_id uuid,
  price_usd     numeric,
  completed_at  timestamptz,
  expiry_at     timestamptz
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
AS $function$
DECLARE
  v_coll        uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;
  v_ceiling     numeric := 10000;
  v_today_start timestamptz := date_trunc('day', now());
  v_today_end   timestamptz := date_trunc('day', now()) + interval '1 day';
  v_rescued     int := 0;
  v_considered  int := 0;
  v_started     timestamptz := clock_timestamp();
BEGIN
  -- per-edition floor ask from the live AllDay listings indexer
  DROP TABLE IF EXISTS _ad_ask;
  CREATE TEMP TABLE _ad_ask ON COMMIT DROP AS
  SELECT cl.edition_id, MIN(cl.price_usd) AS low_ask
  FROM cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
  GROUP BY cl.edition_id;

  -- restrict to editions whose LATEST FMV is STALE or NO_DATA — the genuine
  -- rescue set. Never touch HIGH/MEDIUM/LOW/ASK_ONLY/SALES_ONLY (don't clobber a
  -- usable confidence or churn an existing ask floor).
  DROP TABLE IF EXISTS _ad_targets;
  CREATE TEMP TABLE _ad_targets ON COMMIT DROP AS
  SELECT a.edition_id, a.low_ask
  FROM _ad_ask a
  JOIN LATERAL (
    SELECT fs.confidence::text AS conf
    FROM fmv_snapshots fs
    WHERE fs.edition_id = a.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE latest.conf IN ('STALE','NO_DATA');

  v_considered := (SELECT count(*) FROM _ad_targets);

  IF v_considered > 0 THEN
    -- FMV write pattern: delete-then-insert for today, never upsert
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
          jsonb_build_object('rescued', v_rescued, 'considered', v_considered));

  RETURN QUERY SELECT v_rescued, v_considered;
END;
$function$;
-- <<< END verbatim refresh_allday_ask_fmv_from_listings <<<

\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set eStale   '''e0000000-0000-0000-0000-0000000000a1'''
\set eNoData  '''e0000000-0000-0000-0000-0000000000a2'''
\set eHigh    '''e0000000-0000-0000-0000-0000000000a3'''
\set eCeiling '''e0000000-0000-0000-0000-0000000000a4'''
\set eDone    '''e0000000-0000-0000-0000-0000000000a5'''

-- Listings: eStale has two (MIN 100 wins), eNoData one (50), eHigh one (60),
-- eCeiling one ABOVE the $10k ceiling (ignored), eDone one but completed (ignored).
INSERT INTO public.cached_listings_v2 (edition_id, collection_id, price_usd, completed_at, expiry_at) VALUES
  (:eStale::uuid,   :ad::uuid, 200, NULL, NULL),
  (:eStale::uuid,   :ad::uuid, 100, NULL, now() + interval '1 day'),
  (:eNoData::uuid,  :ad::uuid,  50, NULL, NULL),
  (:eHigh::uuid,    :ad::uuid,  60, NULL, NULL),
  (:eCeiling::uuid, :ad::uuid, 20000, NULL, NULL),
  (:eDone::uuid,    :ad::uuid,  40, now(), NULL);   -- completed → excluded

-- Latest snapshot per edition sets the rescue gate. eStale also has a YESTERDAY
-- row that must survive the today-only delete.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, computed_at, collection) VALUES
  (:eStale::uuid,   :ad::uuid, 'STALE',   date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  (:eStale::uuid,   :ad::uuid, 'ASK_ONLY',date_trunc('day', now()) - interval '3 hours', 'nfl_all_day'),
  (:eNoData::uuid,  :ad::uuid, 'NO_DATA', date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  (:eHigh::uuid,    :ad::uuid, 'HIGH',    date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  (:eCeiling::uuid, :ad::uuid, 'STALE',   date_trunc('day', now()) + interval '1 hour', 'nfl_all_day');

CREATE TEMP TABLE _r AS SELECT * FROM public.refresh_allday_ask_fmv_from_listings();

-- ── Return tuple (rescued, considered) = (2, 2): only eStale + eNoData ───────
SELECT _assert_eq((SELECT rescued::text FROM _r),    '2', 'rescued = eStale + eNoData (STALE/NO_DATA with a live ask)');
SELECT _assert_eq((SELECT considered::text FROM _r), '2', 'considered = the same two — HIGH/ceiling/completed never enter');

-- ── eStale: ASK_ONLY written, fmv = MIN ask (100) * 0.90 = 90, floor = 100 ───
SELECT _assert_eq((SELECT fmv_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eStale::uuid AND computed_at >= date_trunc('day', now())), '90.00',
  'fmv is a 10%% haircut off the MIN live ask (min(100,200)=100 -> 90.00)');
SELECT _assert_eq((SELECT floor_price_usd::text FROM public.fmv_snapshots
  WHERE edition_id=:eStale::uuid AND computed_at >= date_trunc('day', now())), '100.00',
  'the floor records the raw ask');
SELECT _assert_eq((SELECT confidence::text FROM public.fmv_snapshots
  WHERE edition_id=:eStale::uuid AND computed_at >= date_trunc('day', now())), 'ASK_ONLY',
  'a listing-derived rescue is graded ASK_ONLY');

-- ── delete-then-insert TODAY only: eStale keeps its yesterday row (2 total) ──
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id=:eStale::uuid), '2',
  'the pre-today snapshot survives; only today was replaced');

-- ── eHigh is never touched (the rescue gate is STALE/NO_DATA only) ───────────
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id=:eHigh::uuid), '1',
  'a HIGH edition gets no ASK_ONLY rescue row');

-- ── ceiling + completed editions never get a snapshot ───────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id=:eCeiling::uuid AND confidence='ASK_ONLY'), '0',
  'an ask above the $10k ceiling is ignored — no rescue');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.fmv_snapshots WHERE edition_id=:eDone::uuid),
  'a completed listing yields no ask and no rescue');

-- ── the pipeline_runs audit row is written with the counts ──────────────────
SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs
  WHERE pipeline='allday-listing-ask-fmv' AND ok
    AND (extra->>'rescued')='2' AND (extra->>'considered')='2'), '1',
  'a pipeline_runs audit row records rescued/considered');

SELECT '✓ refresh_allday_ask_fmv_from_listings invariants pass' AS result;
ROLLBACK;
