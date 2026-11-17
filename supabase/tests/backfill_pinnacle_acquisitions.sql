-- DB invariant: public.backfill_pinnacle_acquisitions — pg_cron
-- `rpc-backfill-pinnacle-acquisitions` @ `17 */6 * * *`. Sibling of
-- backfill_pinnacle_mint_acquisitions; read that file's header too, because the
-- ASYMMETRY between the two is the thing most likely to be "fixed" into a bug.
--
-- WHY IT MATTERS. It writes `moment_acquisitions`, the COST BASIS table. Unlike
-- the mint path this one DOES write a `buy_price`, so it is the row a collector's
-- displayed profit is computed against. A wrong price here is a wrong P&L on
-- someone's own collection, rendered confidently and with no error anywhere.
--
-- THE FOUR PROPERTIES:
--
--   1. ⚠ ONLY PRICED SALES QUALIFY (`ps.sale_price_usd > 0`). A zero- or
--      NULL-priced sale must never become a cost basis of 0 — that renders as a
--      100%-profit moment. This is the same invariant the mint path achieves by
--      omitting the column entirely, reached from the other direction.
--   2. ⚠ NO nft_id-SCOPED GATE, DELIBERATELY. A moment legitimately changes
--      hands many times, so this path relies on
--      `ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING` and writes one
--      row per (wallet, tx). Adding the mint path's
--      `NOT EXISTS (... WHERE a.nft_id = ...)` here — which would look like
--      making the pair consistent — would silently drop every resale after the
--      first, so a collector who bought a moment previously owned by someone else
--      would show NO cost basis at all.
--   3. The buyer join is on `ps.buyer_address = wmc.wallet_address` and scoped to
--      the Pinnacle collection_id.
--   4. `tx_hash` is derived from the sale id's first `_`-delimited segment, with
--      a synthesized fallback — never blank, because blank collides on the
--      conflict key and would collapse distinct purchases into one row.
--
-- ⚠ NOTE THE CASE ASYMMETRY WITH THE MINT SIBLING, which is a real difference and
-- not an oversight to normalise here: the mint path joins wallets with
-- `lower(...) = lower(...)`, this one joins them exactly. Both are pinned as they
-- are; if the exact join is ever found to be missing rows in production that is a
-- BEHAVIOUR change to make with a measurement, not a tidy-up.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260904014220_audit_20260904_backfill_pinnacle_acquisitions_gains_a_recency_window.sql),
-- which added `p_since_days` (NULL = unbounded; the cron passes 14) on 2026-09-04.
-- Before that it matched the 2026-08-16 snapshot (md5 8f83d9170e3e025d0b271ae5880589b7).
-- Every section below calls with the DEFAULT, so the pinned properties are exercised
-- exactly as before; section 5 pins the window itself.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_sales (
  id             text,
  nft_id         text,
  buyer_address  text,
  seller_address text,
  sale_price_usd numeric,
  sold_at        timestamptz
);

CREATE TABLE public.wallet_moments_cache (
  moment_id      text,
  wallet_address text,
  collection_id  uuid
);

CREATE TABLE public.moment_acquisitions (
  nft_id                 text,
  wallet                 text,
  buy_price              numeric,
  acquired_date          timestamptz,
  acquired_type          int,
  acquisition_method     text,
  acquisition_confidence text,
  seller_address         text,
  transaction_hash       text,
  source                 text,
  collection_id          uuid,
  UNIQUE (nft_id, wallet, transaction_hash)
);

-- >>> BEGIN verbatim backfill_pinnacle_acquisitions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_pinnacle_acquisitions(p_limit integer DEFAULT 50000, p_since_days integer DEFAULT NULL)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_pin uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  WITH candidates AS (
    SELECT ps.nft_id,
           wmc.wallet_address AS wallet,
           ps.sale_price_usd  AS buy_price,
           ps.sold_at         AS acquired_date,
           ps.seller_address,
           COALESCE(NULLIF(split_part(ps.id, '_', 1), ''), 'pinnacle_backfill:' || ps.nft_id) AS tx_hash
    FROM wallet_moments_cache wmc
    JOIN pinnacle_sales ps
      ON ps.nft_id = wmc.moment_id
     AND ps.buyer_address = wmc.wallet_address
    WHERE wmc.collection_id = v_pin
      AND ps.sale_price_usd > 0
      -- Recency window (2026-09-04). NULL = unbounded (the historical backfill);
      -- the cron passes 14 so a tick scans days of sales, not the whole join.
      AND (p_since_days IS NULL OR ps.sold_at > now() - make_interval(days => p_since_days))
    LIMIT p_limit
  ),
  ins AS (
    INSERT INTO moment_acquisitions (
      nft_id, wallet, buy_price, acquired_date, acquired_type,
      acquisition_method, acquisition_confidence,
      seller_address, transaction_hash, source, collection_id
    )
    SELECT
      nft_id, wallet, buy_price, acquired_date, 1,
      'marketplace', 'verified',
      seller_address, tx_hash,
      'pinnacle_sales_join_wmc', v_pin
    FROM candidates
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins INTO v_inserted;

  RETURN json_build_object('collection', 'disney_pinnacle', 'inserted', v_inserted);
END;
$function$;
-- <<< END verbatim backfill_pinnacle_acquisitions <<<

\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set OTHER '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.wallet_moments_cache (moment_id, wallet_address, collection_id) VALUES
  ('n1', '0xAAAA', :PIN::uuid),
  ('n2', '0xBBBB', :PIN::uuid),   -- zero-priced sale
  ('n3', '0xCCCC', :PIN::uuid),   -- NULL-priced sale
  ('n4', '0xDDDD', :OTHER::uuid), -- wrong collection
  ('n5', '0xEEEE', :PIN::uuid);   -- sale id has no '_' segment

INSERT INTO public.pinnacle_sales (id, nft_id, buyer_address, seller_address, sale_price_usd, sold_at) VALUES
  ('txA_1',  'n1', '0xAAAA', '0xS1', 125.50, '2026-05-01T00:00:00Z'),
  ('txB_1',  'n2', '0xBBBB', '0xS2',   0.00, '2026-05-02T00:00:00Z'),
  ('txC_1',  'n3', '0xCCCC', '0xS3',   NULL, '2026-05-03T00:00:00Z'),
  ('txD_1',  'n4', '0xDDDD', '0xS4',  50.00, '2026-05-04T00:00:00Z'),
  ('txE',    'n5', '0xEEEE', '0xS5',  75.25, '2026-05-05T00:00:00Z');

SELECT _assert_eq(
  (public.backfill_pinnacle_acquisitions() ->> 'inserted'), '2',
  'only the two PRICED, in-collection sales qualify (n1, n5)'
);

-- ── 1. A ZERO OR NULL PRICE MUST NOT BECOME A COST BASIS ────────────────────
-- ⚠ The most important assertion here, and the mirror of the mint path's
-- "buy_price stays NULL". A basis of 0 renders as a 100%-profit moment on the
-- collector's own portfolio — confidently wrong, with no error anywhere.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id IN ('n2', 'n3')),
  '0',
  'a zero-priced or NULL-priced sale is not written at all'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE buy_price IS NULL OR buy_price <= 0),
  '0',
  'no row this path writes may carry a non-positive basis'
);

SELECT _assert_eq(
  (SELECT buy_price::text FROM public.moment_acquisitions WHERE nft_id = 'n1'),
  '125.50',
  'the sale price is carried through unchanged'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions
    WHERE acquisition_method = 'marketplace' AND acquisition_confidence = 'verified'
      AND source = 'pinnacle_sales_join_wmc' AND acquired_type = 1),
  '2',
  'every row is labelled marketplace/verified'
);

SELECT _assert_eq(
  (SELECT seller_address FROM public.moment_acquisitions WHERE nft_id = 'n1'),
  '0xS1',
  'the counterparty is recorded'
);

-- ── 2. tx_hash derivation ───────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT transaction_hash FROM public.moment_acquisitions WHERE nft_id = 'n1'),
  'txA',
  'tx_hash is the first _-delimited segment of the sale id'
);

SELECT _assert_eq(
  (SELECT transaction_hash FROM public.moment_acquisitions WHERE nft_id = 'n5'),
  'txE',
  'a sale id with no _ yields the whole id, not a blank'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id = 'n4'),
  '0',
  'a wmc row in another collection is out of scope'
);

-- ── 3. MULTIPLE OWNERS OF ONE MOMENT ALL GET A BASIS ────────────────────────
-- ⚠ THE ASYMMETRY WITH THE MINT SIBLING, asserted directly. A moment changes
-- hands, and each owner needs their own cost basis. If this path ever gained the
-- mint path's nft_id-scoped NOT EXISTS gate — which would look like making the
-- pair consistent — the second buyer would show NO cost basis at all.
INSERT INTO public.wallet_moments_cache (moment_id, wallet_address, collection_id)
  VALUES ('n1', '0xNEW', :PIN::uuid);
INSERT INTO public.pinnacle_sales (id, nft_id, buyer_address, seller_address, sale_price_usd, sold_at)
  VALUES ('txF_1', 'n1', '0xNEW', '0xAAAA', 400.00, '2026-06-01T00:00:00Z');

SELECT _assert_eq(
  (public.backfill_pinnacle_acquisitions() ->> 'inserted'), '1',
  'a RESALE of an already-recorded moment is written for the new owner'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id = 'n1'),
  '2',
  'both owners of the moment carry their own basis'
);

SELECT _assert_eq(
  (SELECT buy_price::text FROM public.moment_acquisitions WHERE nft_id = 'n1' AND wallet = '0xNEW'),
  '400.00',
  'and the new owner gets THEIR price, not the previous one'
);

-- ── 4. RE-RUNNING IS A NO-OP ────────────────────────────────────────────────
-- ⚠ Here idempotence rests ENTIRELY on ON CONFLICT — there is no NOT EXISTS gate
-- on this path — so this is the assertion that would catch the conflict key
-- being widened or dropped.
SELECT _assert_eq(
  (public.backfill_pinnacle_acquisitions() ->> 'inserted'), '0',
  'a second run inserts nothing'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions), '3',
  'and the table is unchanged'
);

-- ── 5. THE RECENCY WINDOW (2026-09-04) ───────────────────────────────────────
-- `p_since_days` bounds `ps.sold_at`; NULL (the default, used by every section
-- above) is unbounded. The cron passes 14 so a tick scans days of sales, not the
-- whole join. Pinned both ways: a window that excludes the fixtures' 2026-05/06
-- sales inserts nothing, and a sale dated now() lands inside a 1-day window.
INSERT INTO public.wallet_moments_cache (moment_id, wallet_address, collection_id)
  VALUES ('n9', '0xRECENT', :PIN::uuid);
INSERT INTO public.pinnacle_sales (id, nft_id, buyer_address, seller_address, sale_price_usd, sold_at)
  VALUES ('txG_1', 'n9', '0xRECENT', '0xS9', 12.00, now() - interval '1 hour');

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pinnacle_sales WHERE sold_at > now() - interval '1 day' AND nft_id <> 'n9'),
  '0',
  'control: the pre-existing fixtures all sit OUTSIDE a 1-day window (they are dated 2026-05/06)'
);

SELECT _assert_eq(
  (public.backfill_pinnacle_acquisitions(50000, 1) ->> 'inserted'), '1',
  'a 1-day window admits the sale dated an hour ago and nothing older'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id = 'n9'),
  '1',
  'and it is the recent sale that landed'
);

SELECT _assert_eq(
  (public.backfill_pinnacle_acquisitions(50000, 1) ->> 'inserted'), '0',
  'a second windowed run inserts nothing (idempotence still rests on ON CONFLICT)'
);

ROLLBACK;
