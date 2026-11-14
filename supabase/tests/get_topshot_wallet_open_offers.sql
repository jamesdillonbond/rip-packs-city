-- DB invariant: get_topshot_wallet_open_offers(p_wallet, p_limit) — feedback #12361, "my open offers".
-- Pinned 2026-11-14. What must hold:
--   1. only the wallet's OPEN Top Shot offers appear — never another wallet's, never filled/cancelled,
--      never another collection's;
--   2. outbid = a higher open offer by ANOTHER wallet on the same edition (top_other_bid > amount);
--   3. the wallet's own two offers: the lower one is SUPERSEDED (own_higher_usd), and NOT outbid —
--      its own higher bid never counts as a competing bid;
--   4. a serial offer is beaten by another wallet's EDITION offer on its edition (an owner can accept either);
--   5. a NULL floor stays NULL (unknown, never 0); a serial ask is reported only when a listing was seen;
--   6. p_limit caps the rows, newest first.
-- The function DDL is VERBATIM from
-- supabase/migrations/20261114161212_audit_20261114_wallet_open_offers_vs_top_bid_and_floor.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, external_id text, player_name text, set_name text, tier text, subedition_name text
);
CREATE TABLE public.moments (id uuid PRIMARY KEY, nft_id text, serial_number int);
CREATE TABLE public.offers (
  offer_id text PRIMARY KEY, collection_id uuid, edition_id uuid, moment_id uuid, serial_number int,
  offer_amount_usd numeric, buyer_address text, offer_type text, status text, created_at timestamptz
);
CREATE TABLE public.edition_offers (
  collection_id uuid, external_id text, low_ask numeric, low_ask_confirmed_at timestamptz,
  PRIMARY KEY (collection_id, external_id)
);
CREATE TABLE public.ts_listings (listing_id text PRIMARY KEY, flow_id text, price_usd numeric, ingested_at timestamptz);

-- >>> BEGIN verbatim get_topshot_wallet_open_offers >>>
CREATE OR REPLACE FUNCTION public.get_topshot_wallet_open_offers(p_wallet text, p_limit int DEFAULT 200)
RETURNS TABLE (
  offer_id text,
  offer_type text,
  amount_usd numeric,
  created_at timestamptz,
  edition_id uuid,
  external_id text,
  player_name text,
  set_name text,
  tier text,
  parallel text,
  serial_number int,
  top_other_bid numeric,
  own_higher_usd numeric,
  floor_usd numeric,
  floor_confirmed_at timestamptz,
  serial_ask_usd numeric,
  serial_ask_seen_at timestamptz,
  age_days numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
BEGIN
  IF p_wallet IS NULL OR btrim(p_wallet) = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH mine AS MATERIALIZED (
    SELECT o.offer_id, o.offer_type, o.offer_amount_usd, o.created_at, o.edition_id, o.moment_id, o.serial_number
      FROM public.offers o
     WHERE o.collection_id = c_ts
       AND o.buyer_address = p_wallet
       AND o.status = 'open'
     ORDER BY o.created_at DESC, o.offer_id DESC
     LIMIT v_limit
  ),
  ed_comp AS (
    SELECT x.edition_id,
           max(x.offer_amount_usd) FILTER (WHERE x.buyer_address <> p_wallet) AS top_other,
           max(x.offer_amount_usd) FILTER (WHERE x.buyer_address = p_wallet)  AS own_top
      FROM public.offers x
     WHERE x.collection_id = c_ts
       AND x.status = 'open'
       AND x.offer_type <> 'serial'
       AND x.edition_id IN (SELECT m.edition_id FROM mine m WHERE m.edition_id IS NOT NULL)
     GROUP BY x.edition_id
  ),
  ser_comp AS (
    SELECT x.moment_id,
           max(x.offer_amount_usd) FILTER (WHERE x.buyer_address <> p_wallet) AS top_other,
           max(x.offer_amount_usd) FILTER (WHERE x.buyer_address = p_wallet)  AS own_top
      FROM public.offers x
     WHERE x.collection_id = c_ts
       AND x.status = 'open'
       AND x.offer_type = 'serial'
       AND x.moment_id IN (SELECT m.moment_id FROM mine m WHERE m.offer_type = 'serial' AND m.moment_id IS NOT NULL)
     GROUP BY x.moment_id
  )
  SELECT m.offer_id::text,
         m.offer_type::text,
         m.offer_amount_usd,
         m.created_at,
         m.edition_id,
         e.external_id::text,
         e.player_name,
         e.set_name,
         e.tier::text,
         e.subedition_name,
         coalesce(m.serial_number, mo.serial_number),
         CASE WHEN m.offer_type = 'serial' THEN greatest(sc.top_other, ec.top_other) ELSE ec.top_other END,
         CASE
           WHEN m.offer_type = 'serial' THEN
             CASE WHEN greatest(sc.own_top, ec.own_top) > m.offer_amount_usd THEN greatest(sc.own_top, ec.own_top) END
           ELSE
             CASE WHEN ec.own_top > m.offer_amount_usd THEN ec.own_top END
         END,
         eo.low_ask,
         eo.low_ask_confirmed_at,
         sa.ask_usd,
         sa.seen_at,
         round((extract(epoch FROM (now() - m.created_at)) / 86400.0)::numeric, 1)
    FROM mine m
    LEFT JOIN ed_comp ec ON ec.edition_id = m.edition_id
    LEFT JOIN ser_comp sc ON sc.moment_id = m.moment_id AND m.offer_type = 'serial'
    LEFT JOIN public.editions e ON e.id = m.edition_id
    LEFT JOIN public.edition_offers eo ON eo.collection_id = e.collection_id AND eo.external_id = e.external_id
    LEFT JOIN public.moments mo ON mo.id = m.moment_id AND m.offer_type = 'serial'
    LEFT JOIN LATERAL (
      SELECT min(l.price_usd) AS ask_usd, max(l.ingested_at) AS seen_at
        FROM public.ts_listings l
       WHERE mo.nft_id IS NOT NULL
         AND l.flow_id = mo.nft_id::text
    ) sa ON m.offer_type = 'serial'
   ORDER BY m.created_at DESC, m.offer_id DESC;
END
$fn$;
-- <<< END verbatim get_topshot_wallet_open_offers <<<

-- Fixtures. TS = Top Shot; OTHER = another collection.
--   E1 '1:1'       floor $10      : ME $5 (older) + ME $8 (newer) — superseded, not outbid
--   E2 '2:2'       floor NULL     : ME $3, BOB $4 open, CAROL $9 FILLED — outbid by $4 (filled ignored)
--   E3 '3:3::1'    floor $6       : ME subedition $7 — at/above floor, no competition
--   E4 '4:4'       floor $50      : ME serial $20 on M4 (#23); DAN serial $15 on M4; EVE edition $25 on E4 → outbid by $25
--                                   M4 listed in ts_listings at $40
--   E5 '5:5'                      : ME serial $2 on M5 — no listing seen → serial ask NULL
--   ME cancelled $100 on E1, ME open on OTHER collection — never appear; BOB's open offer never appears for ME.
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000e1','95f28a17-224a-4025-96ad-adf8a4c63bfd','1:1','P One','S One','COMMON',NULL),
  ('00000000-0000-0000-0000-0000000000e2','95f28a17-224a-4025-96ad-adf8a4c63bfd','2:2','P Two','S Two','RARE',NULL),
  ('00000000-0000-0000-0000-0000000000e3','95f28a17-224a-4025-96ad-adf8a4c63bfd','3:3::1','P Three','S Three','COMMON','Holo MMXX'),
  ('00000000-0000-0000-0000-0000000000e4','95f28a17-224a-4025-96ad-adf8a4c63bfd','4:4','P Four','S Four','LEGENDARY',NULL),
  ('00000000-0000-0000-0000-0000000000e5','95f28a17-224a-4025-96ad-adf8a4c63bfd','5:5','P Five','S Five','COMMON',NULL),
  ('00000000-0000-0000-0000-0000000000f1','e3b0c442-0000-0000-0000-000000000000','9:9','Other','Other','COMMON',NULL);
INSERT INTO public.moments VALUES
  ('00000000-0000-0000-0000-0000000000a4','1004',23),
  ('00000000-0000-0000-0000-0000000000a5','1005',7);
INSERT INTO public.edition_offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','1:1',10,'2026-11-14 10:00+00'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','2:2',NULL,NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','3:3::1',6,'2026-11-14 10:00+00'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','4:4',50,'2026-11-14 10:00+00');
INSERT INTO public.ts_listings VALUES ('L1','1004',40,'2026-11-14 11:00+00');
INSERT INTO public.offers VALUES
  ('o1','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e1',NULL,NULL,5,'0xme','edition','open',now() - interval '20 days'),
  ('o2','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e1',NULL,NULL,8,'0xme','edition','open',now() - interval '1 day'),
  ('o3','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e2',NULL,NULL,3,'0xme','edition','open',now() - interval '2 days'),
  ('o4','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e2',NULL,NULL,4,'0xbob','edition','open',now() - interval '2 days'),
  ('o5','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e2',NULL,NULL,9,'0xcarol','edition','filled',now() - interval '2 days'),
  ('o6','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e3',NULL,NULL,7,'0xme','subedition','open',now() - interval '3 days'),
  ('o7','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000a4',23,20,'0xme','serial','open',now() - interval '4 days'),
  ('o8','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000a4',23,15,'0xdan','serial','open',now() - interval '4 days'),
  ('o9','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e4',NULL,NULL,25,'0xeve','edition','open',now() - interval '4 days'),
  ('o10','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e5','00000000-0000-0000-0000-0000000000a5',NULL,2,'0xme','serial','open',now() - interval '5 days'),
  ('o11','95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000e1',NULL,NULL,100,'0xme','edition','cancelled',now() - interval '1 hour'),
  ('o12','e3b0c442-0000-0000-0000-000000000000','00000000-0000-0000-0000-0000000000f1',NULL,NULL,50,'0xme','edition','open',now() - interval '1 hour');

CREATE TEMP TABLE r AS SELECT * FROM public.get_topshot_wallet_open_offers('0xme');

-- 1. population
SELECT _assert_eq((SELECT string_agg(offer_id, ',' ORDER BY offer_id) FROM r), 'o1,o10,o2,o3,o6,o7',
  'only ME''s open Top Shot offers (no filled/cancelled, no other wallet, no other collection)');
SELECT _assert_eq((SELECT string_agg(offer_id, ',') FROM r), 'o2,o3,o6,o7,o10,o1', 'newest first');

-- 2. outbid by another wallet; a FILLED higher offer is not competition
SELECT _assert_eq((SELECT top_other_bid::text FROM r WHERE offer_id='o3'), '4', 'o3 outbid by BOB''s open $4 (CAROL''s filled $9 ignored)');
SELECT _assert_eq((SELECT own_higher_usd::text FROM r WHERE offer_id='o3'), NULL, 'o3 has no own higher bid');

-- 3. own two offers: superseded, NOT outbid
SELECT _assert_eq((SELECT own_higher_usd::text FROM r WHERE offer_id='o1'), '8', 'o1 superseded by ME''s own $8');
SELECT _assert_eq((SELECT top_other_bid::text FROM r WHERE offer_id='o1'), NULL, 'o1 is NOT outbid — ME''s own bid is not a competing bid');
SELECT _assert_eq((SELECT own_higher_usd::text FROM r WHERE offer_id='o2'), NULL, 'the higher own offer is not superseded by itself');
SELECT _assert_eq((SELECT top_other_bid::text FROM r WHERE offer_id='o2'), NULL, 'o2 has no competing bid');

-- 4. serial offer beaten by an edition offer on its edition (DAN's lower serial bid alone would not)
SELECT _assert_eq((SELECT top_other_bid::text FROM r WHERE offer_id='o7'), '25', 'serial o7: top other bid is EVE''s $25 edition offer');
SELECT _assert_eq((SELECT serial_number::text FROM r WHERE offer_id='o10'), '7', 'serial number falls back to the moment');
SELECT _assert_eq((SELECT top_other_bid::text FROM r WHERE offer_id='o10'), NULL, 'o10 has no competition');

-- 5. floor + serial ask: unknown stays NULL
SELECT _assert_eq((SELECT floor_usd::text FROM r WHERE offer_id='o3'), NULL, 'NULL floor stays NULL, never 0');
SELECT _assert_eq((SELECT floor_usd::text FROM r WHERE offer_id='o6'), '6', 'subedition offer reads its parallel edition''s floor');
SELECT _assert_eq((SELECT parallel FROM r WHERE offer_id='o6'), 'Holo MMXX', 'parallel label');
SELECT _assert_eq((SELECT serial_ask_usd::text FROM r WHERE offer_id='o7'), '40', 'serial ask seen in ts_listings');
SELECT _assert_eq((SELECT serial_ask_usd::text FROM r WHERE offer_id='o10'), NULL, 'no listing seen → NULL (not seen, never "not listed")');
SELECT _assert_eq((SELECT serial_ask_usd::text FROM r WHERE offer_id='o2'), NULL, 'non-serial offers carry no serial ask');
SELECT _assert((SELECT age_days BETWEEN 19.9 AND 20.1 FROM r WHERE offer_id='o1'), 'age_days ~20');

-- 6. limit + empty wallet
SELECT _assert_eq((SELECT string_agg(offer_id, ',') FROM public.get_topshot_wallet_open_offers('0xme', 2)), 'o2,o3', 'p_limit caps newest first');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_topshot_wallet_open_offers('', 50)), '0', 'blank wallet → no rows');
SELECT _assert_eq((SELECT string_agg(offer_id, ',') FROM public.get_topshot_wallet_open_offers('0xbob')), 'o4', 'BOB sees only his own offer');
SELECT _assert_eq((SELECT top_other_bid::text FROM public.get_topshot_wallet_open_offers('0xbob')), '3', 'BOB sees ME''s $3 as the top OTHER bid — below his $4, so not outbid');

\echo '✓ get_topshot_wallet_open_offers: own-only population, outbid vs superseded, serial vs edition competition, NULL floor/ask'

ROLLBACK;
