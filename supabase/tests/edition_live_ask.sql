-- DB invariant: public.edition_live_ask(uuid, text) -- the LIVE low ask of ONE edition, read
-- by both FMV-alert functions (check_triggered_fmv_alerts, dispatch_triggered_fmv_alerts).
-- The SQL twin of lib/asks/edition-live-ask.ts. Pinned: source priority (All Day floor / Candy
-- confirmed floor > edition_offers seen <= 7 d > badge_editions <= 7 d), freshness on
-- low_ask_confirmed_at (NOT updated_at) for edition_offers, the <= 3x FMV gate with the first
-- CONNECTED candidate winning, no FMV -> no ask, a zero ask ignored, and the EDITION key: a
-- same-named key in another collection is never read (#183: the old name match mixed parallels).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261010142824_audit_20261010_fmv_alerts_read_the_editions_own_live_ask.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (id uuid, external_id text, collection_id uuid);
CREATE TABLE edition_fmv_current (edition_id uuid, fmv_usd numeric);
CREATE TABLE allday_edition_floor_ask (edition_id uuid, floor_ask numeric);
CREATE TABLE candy_listing_floor (edition_id uuid, confirmed_floor_usd numeric);
CREATE TABLE edition_offers (collection_id uuid, external_id text, low_ask numeric, low_ask_confirmed_at timestamptz, updated_at timestamptz);
CREATE TABLE badge_editions (collection_id uuid, external_id text, low_ask numeric, updated_at timestamptz);

-- >>> BEGIN verbatim edition_live_ask (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.edition_live_ask(p_collection_id uuid, p_edition_key text)
 RETURNS TABLE(ask numeric, source text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The LIVE low ask of ONE edition: what a buyer would pay now. The SQL twin of
  -- lib/asks/edition-live-ask.ts (resolveLiveAsks); keep the two rules identical.
  --   priority 1: allday_edition_floor_ask (ghost listings excluded) / candy_listing_floor.confirmed_floor_usd
  --   priority 2: edition_offers.low_ask last SEEN (low_ask_confirmed_at) within 7 days
  --   priority 3: badge_editions.low_ask updated within 7 days
  -- An ask is returned only when the edition has an FMV and the ask is <= 3x it
  -- (the estate's disconnected-ask multiple). No row = no usable ask, never 0.
  WITH ed AS (
    SELECT e.id FROM public.editions e
     WHERE e.collection_id = p_collection_id AND e.external_id = p_edition_key
     LIMIT 1
  ), fmv AS (
    SELECT f.fmv_usd FROM public.edition_fmv_current f JOIN ed ON f.edition_id = ed.id
     WHERE f.fmv_usd > 0
  ), cand AS (
    SELECT a.floor_ask AS ask, 'allday_floor'::text AS source, 1 AS pri
      FROM public.allday_edition_floor_ask a JOIN ed ON a.edition_id = ed.id
    UNION ALL
    SELECT c.confirmed_floor_usd, 'candy_confirmed_floor', 1
      FROM public.candy_listing_floor c JOIN ed ON c.edition_id = ed.id
    UNION ALL
    SELECT o.low_ask, 'edition_offers', 2
      FROM public.edition_offers o
     WHERE o.collection_id = p_collection_id AND o.external_id = p_edition_key
       AND o.low_ask_confirmed_at > now() - interval '7 days'
    UNION ALL
    SELECT b.low_ask, 'badge_editions', 3
      FROM public.badge_editions b
     WHERE b.collection_id = p_collection_id AND b.external_id = p_edition_key
       AND b.updated_at > now() - interval '7 days'
  )
  SELECT cand.ask, cand.source
    FROM cand CROSS JOIN fmv
   WHERE cand.ask > 0 AND cand.ask <= fmv.fmv_usd * 3
   ORDER BY cand.pri, cand.ask
   LIMIT 1;
$function$;
-- <<< END verbatim edition_live_ask <<<

-- Collection A (aaaa), collection B (bbbb). FMV 20 on every A edition except e5.
INSERT INTO editions VALUES
  ('00000000-0000-0000-0000-0000000000e1','k1','00000000-0000-0000-0000-00000000aaaa'),
  ('00000000-0000-0000-0000-0000000000e2','k2','00000000-0000-0000-0000-00000000aaaa'),
  ('00000000-0000-0000-0000-0000000000e3','k3','00000000-0000-0000-0000-00000000aaaa'),
  ('00000000-0000-0000-0000-0000000000e4','k4','00000000-0000-0000-0000-00000000aaaa'),
  ('00000000-0000-0000-0000-0000000000e5','k5','00000000-0000-0000-0000-00000000aaaa'),
  ('00000000-0000-0000-0000-0000000000e6','k6','00000000-0000-0000-0000-00000000aaaa'),
  ('00000000-0000-0000-0000-0000000000e7','k7','00000000-0000-0000-0000-00000000aaaa'),
  ('00000000-0000-0000-0000-0000000000f1','k1','00000000-0000-0000-0000-00000000bbbb');
INSERT INTO edition_fmv_current
  SELECT id, 20 FROM editions WHERE collection_id = '00000000-0000-0000-0000-00000000aaaa' AND external_id <> 'k5';
INSERT INTO edition_fmv_current VALUES ('00000000-0000-0000-0000-0000000000f1', 20);

-- k1: offers 10 (seen now) beats a LOWER badge 8 on priority.
INSERT INTO edition_offers VALUES ('00000000-0000-0000-0000-00000000aaaa','k1',10, now(), now());
INSERT INTO badge_editions VALUES ('00000000-0000-0000-0000-00000000aaaa','k1', 8, now());
-- k1 in collection B: a cheaper ask on the SAME key in ANOTHER collection must never be read.
INSERT INTO edition_offers VALUES ('00000000-0000-0000-0000-00000000bbbb','k1', 1, now(), now());
-- k2: offers last SEEN 8 d ago (updated_at fresh -- freshness must read low_ask_confirmed_at); badge 12 fresh wins.
INSERT INTO edition_offers VALUES ('00000000-0000-0000-0000-00000000aaaa','k2', 9, now() - interval '8 days', now());
INSERT INTO badge_editions VALUES ('00000000-0000-0000-0000-00000000aaaa','k2',12, now());
-- k3: All Day floor 5 beats a lower offers ask 4 (priority 1).
INSERT INTO allday_edition_floor_ask VALUES ('00000000-0000-0000-0000-0000000000e3', 5);
INSERT INTO edition_offers VALUES ('00000000-0000-0000-0000-00000000aaaa','k3', 4, now(), now());
-- k4: offers 70 > 3x20 is disconnected; the next connected candidate (badge 30) wins.
INSERT INTO edition_offers VALUES ('00000000-0000-0000-0000-00000000aaaa','k4',70, now(), now());
INSERT INTO badge_editions VALUES ('00000000-0000-0000-0000-00000000aaaa','k4',30, now());
-- k5: no FMV -> no ask at all.
INSERT INTO edition_offers VALUES ('00000000-0000-0000-0000-00000000aaaa','k5', 3, now(), now());
-- k6: Candy confirmed floor 7; a zero confirmed floor on k7 is ignored and stale badge too -> none.
INSERT INTO candy_listing_floor VALUES ('00000000-0000-0000-0000-0000000000e6', 7);
INSERT INTO candy_listing_floor VALUES ('00000000-0000-0000-0000-0000000000e7', 0);
INSERT INTO badge_editions VALUES ('00000000-0000-0000-0000-00000000aaaa','k7', 6, now() - interval '8 days');

SELECT _assert_eq((SELECT ask::text||'/'||source FROM edition_live_ask('00000000-0000-0000-0000-00000000aaaa','k1')), '10/edition_offers', 'priority: edition_offers beats a lower badge ask');
SELECT _assert_eq((SELECT ask::text||'/'||source FROM edition_live_ask('00000000-0000-0000-0000-00000000bbbb','k1')), '1/edition_offers', 'collection B reads its own row');
SELECT _assert_eq((SELECT ask::text||'/'||source FROM edition_live_ask('00000000-0000-0000-0000-00000000aaaa','k2')), '12/badge_editions', 'an offers ask unseen 8 d is stale even with a fresh updated_at');
SELECT _assert_eq((SELECT ask::text||'/'||source FROM edition_live_ask('00000000-0000-0000-0000-00000000aaaa','k3')), '5/allday_floor', 'priority 1: the All Day floor beats a lower offers ask');
SELECT _assert_eq((SELECT ask::text||'/'||source FROM edition_live_ask('00000000-0000-0000-0000-00000000aaaa','k4')), '30/badge_editions', 'an ask > 3x FMV is skipped and the next connected one wins');
SELECT _assert_eq((SELECT count(*)::text FROM edition_live_ask('00000000-0000-0000-0000-00000000aaaa','k5')), '0', 'no FMV -> no ask');
SELECT _assert_eq((SELECT ask::text||'/'||source FROM edition_live_ask('00000000-0000-0000-0000-00000000aaaa','k6')), '7/candy_confirmed_floor', 'Candy confirmed floor is read');
SELECT _assert_eq((SELECT count(*)::text FROM edition_live_ask('00000000-0000-0000-0000-00000000aaaa','k7')), '0', 'a zero floor and a stale badge ask give no ask');
SELECT _assert_eq((SELECT count(*)::text FROM edition_live_ask('00000000-0000-0000-0000-00000000aaaa','nope')), '0', 'an unknown edition gives no ask');

SELECT '✓ edition_live_ask invariants pass' AS result;
ROLLBACK;
