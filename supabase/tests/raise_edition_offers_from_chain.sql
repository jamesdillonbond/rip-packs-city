-- DB invariant: public.raise_edition_offers_from_chain — pg_cron
-- `rpc-raise-edition-offers-backstop` @ `34 * * * *`.
--
-- WHAT IT IS. A BACKSTOP for the offers indexer: it re-derives each Top Shot
-- edition's highest open offer from the `offers` table and pushes it into
-- `edition_offers.highest_offer`, the denormalized column the best-offer
-- displays read.
--
-- ⚠ IT IS RAISE-ONLY, AND THAT IS THE WHOLE POINT. A backstop runs on a partial
-- view of the chain, so lowering a value the primary writer set would mean a
-- transient read DELETING a real offer from every surface that shows it. This is
-- exactly the shape a future editor "simplifies" into a plain upsert.
--
-- ⚠ TWO MECHANISMS APPEAR TO ENFORCE IT, BUT ONLY ONE IS LOAD-BEARING — and a
-- mutation proved it, against an earlier version of this very comment that
-- claimed both were "pinned separately". They are not, and they CANNOT be:
--
--   • `WHERE EXCLUDED.highest_offer > COALESCE(existing, 0)` on the DO UPDATE —
--     LOAD-BEARING. Removing it lets a lower chain read overwrite a higher
--     stored value, and also bumps `updated_at` on rows that were not really
--     written. Deleting it reds this file.
--   • `GREATEST(COALESCE(existing, 0), EXCLUDED.highest_offer)` in the SET —
--     REDUNDANT while that guard exists. The guard only admits rows where
--     EXCLUDED > existing, and for those `GREATEST(existing, EXCLUDED)` is
--     EXCLUDED by definition. Replacing it with a plain
--     `SET highest_offer = EXCLUDED.highest_offer` changes NOTHING observable,
--     and this file stays green — verified by mutation, not assumed.
--
-- That is belt-and-braces, and it is fine to keep. It is NOT fine to describe it
-- as a second enforced invariant, because a future reader would trust a
-- protection that no test can detect the loss of. GREATEST becomes load-bearing
-- again the moment the WHERE guard is removed — so if you ever remove that
-- guard deliberately, this note is the reason GREATEST must stay.
--
-- THE OTHER PROPERTIES:
--   • It keys on `editions.external_id`, not `edition_id` — `edition_offers` is
--     external-id keyed, and the join is what bridges them.
--   • It aggregates MAX per edition across many open offers.
--   • It EXCLUDES `subedition` and `serial` offer types. Those are offers on one
--     specific serial or parallel printing, and folding a serial-specific offer
--     into the EDITION-level best offer would publish a number no buyer is
--     actually bidding for the edition as a whole.
--   • Only `status = 'open'` and `offer_amount_usd > 0`.
--
-- ⚠ The return value counts ROWS THE UPSERT ACTUALLY TOUCHED, so an unchanged
-- run returns 0 — and 0 is the healthy steady state here, not a failure. Do not
-- add a monitor that alerts on a zero return.
--
-- ⚠ MARKETPLACE-HIDDEN BIDS (2026-10-31, #220). A chain offer that Top Shot's own
-- index (Atlas) has WALKED PAST (topshot_atlas_edition_verified.verified_at >
-- offer.created_at) and does NOT carry as an open offer (no open
-- topshot_atlas_market_events row with that listing_resource_id) is a bid no
-- collector can accept through the marketplace — Top Shot hides unfunded bids.
-- It must NOT become the published top offer (Simmons Holo Icon 28:880 flip-
-- flopped $180/$18 hourly between this backstop and the Atlas sync). An offer
-- NEWER than the last walk is honoured (Atlas has not seen it yet); an edition
-- Atlas never mapped or walked is honoured (the backstop's original purpose).
-- Candidates are narrowed to offers that would actually raise the stored value
-- BEFORE the probes run (12 of 22k on prod); the probes are LATERAL ... LIMIT 1.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261031210439_audit_20261031_raise_edition_offers_skips_marketplace_hidden_bids.sql).
-- Earlier body: 20260816010000 (md5 c3a32f8a0cb02b285dbe0ef7ea7087e5).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  id            uuid,
  external_id   text,
  collection_id uuid
);

CREATE TABLE public.offers (
  edition_id       uuid,
  collection_id    uuid,
  status           text,
  offer_type       text,
  offer_amount_usd numeric,
  offer_id         text,
  created_at       timestamptz DEFAULT now()
);

-- Top Shot's own index, as the marketplace-hidden test reads it.
CREATE TABLE public.topshot_atlas_edition_map (
  atlas_edition_id text,
  external_id      text
);
CREATE TABLE public.topshot_atlas_edition_verified (
  atlas_edition_id text PRIMARY KEY,
  verified_at      timestamptz,
  complete         boolean
);
CREATE TABLE public.topshot_atlas_market_events (
  product             text,
  atlas_edition_id    text,
  kind                text,
  completed           boolean,
  listing_resource_id text
);

CREATE TABLE public.edition_offers (
  collection_id uuid,
  external_id   text,
  highest_offer numeric,
  updated_at    timestamptz,
  UNIQUE (collection_id, external_id)
);

-- >>> BEGIN verbatim raise_edition_offers_from_chain (keep byte-identical to the pin) >>>
CREATE OR REPLACE FUNCTION public.raise_edition_offers_from_chain()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_n integer;
BEGIN
  WITH cand AS MATERIALIZED (
    -- Only offers that would RAISE the stored value can matter (the ON CONFLICT
    -- guard below admits nothing else), so the marketplace-hidden test runs on a
    -- dozen rows, not 22k. #220, 2026-10-31.
    SELECT e.external_id::text AS external_id, o.offer_amount_usd, o.offer_id, o.created_at, m.atlas_edition_id
    FROM offers o
    JOIN editions e ON e.id = o.edition_id
    LEFT JOIN edition_offers eo
           ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND eo.external_id = e.external_id::text
    LEFT JOIN topshot_atlas_edition_map m ON m.external_id = e.external_id::text
    WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND o.status = 'open'
      AND o.offer_type NOT IN ('subedition','serial')
      AND o.offer_amount_usd > 0
      AND o.offer_amount_usd > COALESCE(eo.highest_offer, 0)
  ), chain AS (
    -- A chain offer Top Shot's own index has walked past and does not carry is a
    -- bid no collector can accept through the marketplace; it must not become the
    -- published top offer. Unwalked-since-bid and unmapped editions are honoured.
    SELECT c.external_id, max(c.offer_amount_usd) AS chain_edition_max
    FROM cand c
    LEFT JOIN LATERAL (SELECT 1 AS walked FROM topshot_atlas_edition_verified v
                        WHERE v.atlas_edition_id = c.atlas_edition_id AND v.verified_at > c.created_at
                        LIMIT 1) w ON true
    LEFT JOIN LATERAL (SELECT 1 AS seen FROM topshot_atlas_market_events ev
                        WHERE ev.product = 'nba' AND ev.atlas_edition_id = c.atlas_edition_id
                          AND ev.kind = 'offer' AND NOT ev.completed
                          AND ev.listing_resource_id = c.offer_id
                        LIMIT 1) s ON w.walked IS NOT NULL
    WHERE NOT (w.walked IS NOT NULL AND s.seen IS NULL)
    GROUP BY c.external_id
  ), upserted AS (
    INSERT INTO edition_offers (collection_id, external_id, highest_offer, updated_at)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, c.external_id, c.chain_edition_max, now()
    FROM chain c
    ON CONFLICT (collection_id, external_id) DO UPDATE
      SET highest_offer = GREATEST(COALESCE(edition_offers.highest_offer, 0), EXCLUDED.highest_offer),
          updated_at = now()
      WHERE EXCLUDED.highest_offer > COALESCE(edition_offers.highest_offer, 0)
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upserted;
  RETURN v_n;
END;
$function$;
-- <<< END verbatim raise_edition_offers_from_chain <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set OTHER '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set e1 '''bbbbbbbb-0000-0000-0000-000000000001'''
\set e2 '''bbbbbbbb-0000-0000-0000-000000000002'''
\set e3 '''bbbbbbbb-0000-0000-0000-000000000003'''
\set e4 '''bbbbbbbb-0000-0000-0000-000000000004'''
\set e5 '''bbbbbbbb-0000-0000-0000-000000000005'''

INSERT INTO public.editions (id, external_id, collection_id) VALUES
  (:e1::uuid, '100:1', :TS::uuid),
  (:e2::uuid, '100:2', :TS::uuid),
  (:e3::uuid, '100:3', :TS::uuid),
  (:e4::uuid, '100:4', :TS::uuid),
  (:e5::uuid, '100:5', :OTHER::uuid);

INSERT INTO public.offers (edition_id, collection_id, status, offer_type, offer_amount_usd) VALUES
  -- e1: three open edition-level offers -> MAX 75 wins
  (:e1::uuid, :TS::uuid, 'open',   'edition', 25),
  (:e1::uuid, :TS::uuid, 'open',   'edition', 75),
  (:e1::uuid, :TS::uuid, 'open',   'edition', 50),
  -- e1: a CLOSED offer far above the max, and a zero-amount one — both ignored
  (:e1::uuid, :TS::uuid, 'closed', 'edition', 9999),
  (:e1::uuid, :TS::uuid, 'open',   'edition', 0),
  -- e2: only serial/subedition offers -> excluded entirely, no row at all
  (:e2::uuid, :TS::uuid, 'open',   'serial', 500),
  (:e2::uuid, :TS::uuid, 'open',   'subedition', 600),
  -- e3: an existing HIGHER stored value must survive a lower chain read
  (:e3::uuid, :TS::uuid, 'open',   'edition', 10),
  -- e4: an existing LOWER stored value must be raised
  (:e4::uuid, :TS::uuid, 'open',   'edition', 200),
  -- e5: right shape but the WRONG collection -> out of scope
  (:e5::uuid, :OTHER::uuid, 'open', 'edition', 400);

INSERT INTO public.edition_offers (collection_id, external_id, highest_offer, updated_at) VALUES
  (:TS::uuid, '100:3', 999, now() - interval '1 day'),
  (:TS::uuid, '100:4',  50, now() - interval '1 day');

SELECT _assert_eq(
  public.raise_edition_offers_from_chain()::text, '2',
  'e1 is inserted and e4 is raised; e3 is left alone and e2/e5 never qualify'
);

SELECT _assert_eq(
  (SELECT highest_offer::text FROM public.edition_offers WHERE external_id = '100:1'),
  '75',
  'the MAX of the open edition-level offers wins'
);

-- ⚠ THE RAISE-ONLY PROPERTY. A backstop sees a partial view of the chain, so
-- lowering a value the primary writer set would DELETE a real offer from every
-- surface that shows it.
SELECT _assert_eq(
  (SELECT highest_offer::text FROM public.edition_offers WHERE external_id = '100:3'),
  '999',
  'a stored value HIGHER than the chain read must survive untouched'
);

SELECT _assert_eq(
  (SELECT (updated_at < now() - interval '1 hour')::text FROM public.edition_offers WHERE external_id = '100:3'),
  'true',
  'and its updated_at is not bumped either — the row was genuinely not written'
);

SELECT _assert_eq(
  (SELECT highest_offer::text FROM public.edition_offers WHERE external_id = '100:4'),
  '200',
  'a stored value LOWER than the chain read IS raised'
);

-- ── Exclusions ──────────────────────────────────────────────────────────────
-- ⚠ serial/subedition offers are bids on ONE specific serial or parallel
-- printing. Folding one into the EDITION-level best offer publishes a number
-- nobody is bidding for the edition as a whole — and it would be the largest
-- number on the page, because a rare-serial bid dwarfs the edition floor.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.edition_offers WHERE external_id = '100:2'),
  '0',
  'an edition whose only offers are serial/subedition gets no edition-level row'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.edition_offers WHERE external_id = '100:5'),
  '0',
  'another collection is out of scope'
);

-- The closed and zero-amount offers on e1 must not have moved it.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.edition_offers WHERE highest_offer >= 9999),
  '0',
  'a CLOSED offer never lands, however large'
);

-- ── Idempotence ─────────────────────────────────────────────────────────────
-- ⚠ It runs hourly, and 0 is the HEALTHY steady state — do not build a monitor
-- that alerts on a zero return.
SELECT _assert_eq(
  public.raise_edition_offers_from_chain()::text, '0',
  'a second run with no new offers touches nothing'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.edition_offers), '3',
  'and no duplicate rows appear — the conflict key holds'
);

-- ── A NEW higher offer does land on the next tick ───────────────────────────
-- The positive half: without this, every assertion above is satisfied by a
-- function that simply never writes.
INSERT INTO public.offers (edition_id, collection_id, status, offer_type, offer_amount_usd)
  VALUES (:e1::uuid, :TS::uuid, 'open', 'edition', 120);

SELECT _assert_eq(
  public.raise_edition_offers_from_chain()::text, '1',
  'a new higher offer is picked up'
);

SELECT _assert_eq(
  (SELECT highest_offer::text FROM public.edition_offers WHERE external_id = '100:1'),
  '120',
  'and it replaces the previous max'
);

-- ── Marketplace-hidden bids (#220) ──────────────────────────────────────────
-- Top Shot's own index walked e6 AFTER both bids landed and carries only the
-- $40 one: the $500 is a bid nobody can accept through the marketplace, and it
-- must not be published. e7's bid is NEWER than its last walk (honoured). e8 is
-- unmapped (honoured). e9's only bid shows in Atlas as COMPLETED, not open —
-- hidden, no row at all.
\set e6 '''bbbbbbbb-0000-0000-0000-000000000006'''
\set e7 '''bbbbbbbb-0000-0000-0000-000000000007'''
\set e8 '''bbbbbbbb-0000-0000-0000-000000000008'''
\set e9 '''bbbbbbbb-0000-0000-0000-000000000009'''
INSERT INTO public.editions (id, external_id, collection_id) VALUES
  (:e6::uuid, '100:6', :TS::uuid),
  (:e7::uuid, '100:7', :TS::uuid),
  (:e8::uuid, '100:8', :TS::uuid),
  (:e9::uuid, '100:9', :TS::uuid);
INSERT INTO public.topshot_atlas_edition_map (atlas_edition_id, external_id) VALUES
  ('A6', '100:6'), ('A7', '100:7'), ('A9', '100:9');
INSERT INTO public.topshot_atlas_edition_verified (atlas_edition_id, verified_at, complete) VALUES
  ('A6', now() - interval '1 hour', false),
  ('A7', now() - interval '10 days', false),
  ('A9', now() - interval '1 hour', true);
INSERT INTO public.offers (edition_id, collection_id, status, offer_type, offer_amount_usd, offer_id, created_at) VALUES
  (:e6::uuid, :TS::uuid, 'open', 'edition', 500, 'HIDDEN-500', now() - interval '10 days'),
  (:e6::uuid, :TS::uuid, 'open', 'edition',  40, 'SEEN-40',    now() - interval '10 days'),
  (:e7::uuid, :TS::uuid, 'open', 'edition', 300, 'NEWER-300',  now() - interval '1 hour'),
  (:e8::uuid, :TS::uuid, 'open', 'edition',  90, 'UNMAPPED-90', now() - interval '10 days'),
  (:e9::uuid, :TS::uuid, 'open', 'edition',  77, 'DONE-77',    now() - interval '10 days');
INSERT INTO public.topshot_atlas_market_events (product, atlas_edition_id, kind, completed, listing_resource_id) VALUES
  ('nba', 'A6', 'offer', false, 'SEEN-40'),
  ('nba', 'A9', 'offer', true,  'DONE-77'),
  -- a LISTING row with the hidden bid's id must not count as "seen" either
  ('nba', 'A6', 'listing', false, 'HIDDEN-500');

SELECT _assert_eq(
  public.raise_edition_offers_from_chain()::text, '3',
  'e6 (at the SEEN amount), e7 and e8 are written; e9 is not'
);
SELECT _assert_eq(
  (SELECT highest_offer::text FROM public.edition_offers WHERE external_id = '100:6'),
  '40',
  'a bid Atlas walked past and does not carry is NOT published — the honoured max wins'
);
SELECT _assert_eq(
  (SELECT highest_offer::text FROM public.edition_offers WHERE external_id = '100:7'),
  '300',
  'a bid newer than the last Atlas walk is honoured (Atlas has not seen it yet)'
);
SELECT _assert_eq(
  (SELECT highest_offer::text FROM public.edition_offers WHERE external_id = '100:8'),
  '90',
  'an edition Atlas never mapped is honoured (the backstop''s original purpose)'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.edition_offers WHERE external_id = '100:9'),
  '0',
  'a bid Atlas shows only as COMPLETED is hidden — no row'
);
-- The hidden bid stays hidden on a later tick too (idempotent, not first-run luck).
SELECT _assert_eq(
  public.raise_edition_offers_from_chain()::text, '0',
  'nothing moves on the next tick'
);

ROLLBACK;
