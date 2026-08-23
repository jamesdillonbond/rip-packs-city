-- DB invariant: public.backfill_pinnacle_trade_acquisitions — pg_cron
-- `rpc-backfill-pinnacle-trade-acquisitions` @ `23 */3 * * *`.
--
-- WHY IT MATTERS. It writes `moment_acquisitions`, the COST BASIS table. Every
-- P&L figure a Pinnacle collector sees on their own moments derives from these
-- rows (`resolveMomentPnlBasis()`, the Cost and P&L columns in
-- CollectionMomentTable). A defect here does not throw — it shows a collector the
-- wrong profit on their own collection.
--
-- ⚠ THIS FUNCTION SITS BESIDE backfill_pinnacle_mint_acquisitions AND IS
-- DELIBERATELY ASYMMETRIC WITH IT. The two are near-identical in shape, which is
-- exactly why the differences need pinning: the tempting "tidy-up" is to make
-- them match.
--
--   1. ⚠ A TRADE WRITES NO buy_price — same as the mint path, same reason. The
--      column is absent from the INSERT column list so it lands NULL. A trade
--      has no cash price (the collector gave up Pins, not dollars), and a 0
--      would render the moment as 100% profit forever. Asserted explicitly
--      because "the column is missing from the list" reads like an oversight.
--
--   2. ⚠ THERE IS NO nft_id-SCOPED `NOT EXISTS` GATE HERE, AND ADDING ONE WOULD
--      BE A REGRESSION. The mint path has one because a mint is the FIRST
--      acquisition of a Pin and must never be inserted retroactively beneath a
--      later purchase. A TRADE IS NOT A FIRST ACQUISITION — a Pin legitimately
--      changes hands many times, so this path takes the MARKETPLACE path's
--      discipline instead: one row per (wallet, tx), deduped only by
--      ON CONFLICT. Copying the mint's gate across — which looks like making
--      two sibling functions consistent — would silently record only a Pin's
--      FIRST trade and drop every later one.
--
--   3. The wallet join is CASE-INSENSITIVE (`lower(...) = lower(...)`). Flow
--      addresses arrive in mixed case from different indexers, and a
--      case-sensitive join silently backfills nothing while reporting ok.
--
--   4. seller_address carries the COUNTERPARTY (`from_wallet`). It is the only
--      record of who the Pin came from, since a trade leaves no sale row.
--
-- ⚠ Deliberately NOT asserted: that `inserted` equals the candidate count. It
-- counts rows the INSERT actually returned, so a row suppressed by ON CONFLICT
-- is correctly excluded — the count is the honest one.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260822180000_pinnacle_trade_events_and_trade_acquisitions.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_trade_events (
  id             text,
  transaction_id text,
  nft_id         text,
  edition_id     text,
  from_wallet    text,
  to_wallet      text,
  traded_at      timestamptz,
  block_height   bigint,
  pins_in_trade  int,
  source         text
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

-- >>> BEGIN verbatim backfill_pinnacle_trade_acquisitions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_pinnacle_trade_acquisitions(p_limit integer DEFAULT 50000)
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
    SELECT t.nft_id,
           wmc.wallet_address AS wallet,
           t.traded_at        AS acquired_date,
           t.from_wallet      AS seller_address,
           COALESCE(NULLIF(t.transaction_id, ''), 'pinnacle_trade:' || t.nft_id) AS tx_hash
    FROM public.pinnacle_trade_events t
    JOIN public.wallet_moments_cache wmc
      ON wmc.moment_id = t.nft_id
     AND wmc.collection_id = v_pin
     AND lower(wmc.wallet_address) = lower(t.to_wallet)
    LIMIT p_limit
  ),
  ins AS (
    INSERT INTO public.moment_acquisitions (
      nft_id, wallet, acquired_date, acquired_type,
      acquisition_method, acquisition_confidence,
      seller_address, transaction_hash, source, collection_id
    )
    SELECT
      nft_id, wallet, acquired_date, 1,
      'trade', 'verified',
      seller_address, tx_hash,
      'pinnacle_trades', v_pin
    FROM candidates
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins INTO v_inserted;

  RETURN json_build_object('collection', 'disney_pinnacle', 'inserted', v_inserted);
END;
$function$;
-- <<< END verbatim backfill_pinnacle_trade_acquisitions <<<

\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set OTHER '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.pinnacle_trade_events
  (id, transaction_id, nft_id, from_wallet, to_wallet, traded_at, block_height, pins_in_trade, source) VALUES
  ('tx1_n1', 'tx1', 'n1', '0xSELL1', '0xAAAA', '2026-05-01T00:00:00Z', 1, 1, 'on-chain'),  -- plain trade in
  ('tx2_n2', '',    'n2', '0xSELL2', '0xBBBB', '2026-05-02T00:00:00Z', 2, 1, 'on-chain'),  -- empty tx -> synthesized
  ('tx3_n3', 'tx3', 'n3', '0xSELL3', '0xDDDD', '2026-05-03T00:00:00Z', 3, 1, 'on-chain'),  -- wmc row is ANOTHER collection
  ('tx4_n4', 'tx4', 'n4', '0xSELL4', '0xeeee', '2026-05-04T00:00:00Z', 4, 1, 'on-chain'),  -- case differs across tables
  -- n5's FIRST trade. Its second is inserted LATER, between two calls — see the
  -- note at section 2 for why that separation is load-bearing.
  ('tx5_n5', 'tx5', 'n5', '0xSELL5', '0xF111', '2026-05-05T00:00:00Z', 5, 1, 'on-chain');

INSERT INTO public.wallet_moments_cache (moment_id, wallet_address, collection_id) VALUES
  ('n1', '0xAAAA', :PIN::uuid),
  ('n2', '0xBBBB', :PIN::uuid),
  ('n3', '0xDDDD', :OTHER::uuid),
  ('n4', '0xEEEE', :PIN::uuid),
  ('n5', '0xF111', :PIN::uuid),
  ('n5', '0xF222', :PIN::uuid);

SELECT _assert_eq(
  (public.backfill_pinnacle_trade_acquisitions() ->> 'inserted'), '4',
  'n1, n2, n4 and n5''s first trade are inserted; n3 is excluded by collection'
);

-- ── 1. A TRADE MUST NOT CARRY A COST BASIS ──────────────────────────────────
-- ⚠ The single most important assertion in this file. A 0 here renders as a
-- 100%-profit moment on the collector's own portfolio, forever. A trade costs
-- Pins, not dollars, and we cannot price that — so the honest value is NULL.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions
    WHERE source = 'pinnacle_trades' AND buy_price IS NOT NULL),
  '0',
  'a trade has no purchase price — buy_price must be NULL, never 0'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions
    WHERE source = 'pinnacle_trades' AND acquisition_method = 'trade'
      AND acquisition_confidence = 'verified' AND acquired_type = 1),
  '4',
  'every trade row is labelled trade/verified'
);

-- ── 2. A PIN THAT TRADES TWICE GETS TWO ROWS ────────────────────────────────
-- ⚠ THE ASYMMETRY WITH THE MINT PATH, AND THE REGRESSION THIS FILE EXISTS TO
-- CATCH. The sibling backfill_pinnacle_mint_acquisitions gates on
-- `NOT EXISTS (... WHERE a.nft_id = m.nft_id)` scoped on nft_id ALONE. Copying
-- that gate here — which looks like making two near-identical functions
-- consistent — would record only a Pin's FIRST trade and silently drop every
-- later one, because by the second trade an acquisition row already exists.
--
-- ⚠⚠ THE SECOND TRADE MUST ARRIVE BETWEEN TWO CALLS, AND THIS IS THE WHOLE
-- POINT — the first draft of this test put both legs in one batch and MUTATION
-- TESTING CAUGHT IT PASSING WITH THE MINT GATE APPLIED. Within a single call all
-- candidates are selected by the CTE before any row is inserted, so the gate
-- reads an empty table and never bites. It only bites on a LATER call, which is
-- exactly how trades really arrive: one cron tick per new trade. A test that
-- batches them asserts the property while being structurally unable to observe
-- its violation.
INSERT INTO public.pinnacle_trade_events
  (id, transaction_id, nft_id, from_wallet, to_wallet, traded_at, block_height, pins_in_trade, source) VALUES
  ('tx6_n5', 'tx6', 'n5', '0xF111', '0xF222', '2026-05-06T00:00:00Z', 6, 1, 'on-chain');

SELECT _assert_eq(
  (public.backfill_pinnacle_trade_acquisitions() ->> 'inserted'), '1',
  'a Pin''s SECOND trade is inserted on a later run — the mint path''s nft_id gate must not be here'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id = 'n5'),
  '2',
  'a Pin that changes hands twice records BOTH trades — no nft_id-scoped gate here'
);

SELECT _assert_eq(
  (SELECT string_agg(wallet, ',' ORDER BY wallet) FROM public.moment_acquisitions WHERE nft_id = 'n5'),
  '0xF111,0xF222',
  'both receiving wallets are recorded, not just the first'
);

-- ── 3. CASE-INSENSITIVE WALLET JOIN ─────────────────────────────────────────
-- The wmc row is '0xEEEE' and the trade's to_wallet is '0xeeee'. A
-- case-sensitive join backfills nothing while still reporting ok.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id = 'n4'),
  '1',
  'the wallet join is case-insensitive across the two tables'
);

-- ── 4. THE COUNTERPARTY IS RECORDED ─────────────────────────────────────────
-- A trade leaves no sale row anywhere, so seller_address is the ONLY record of
-- who the Pin came from.
SELECT _assert_eq(
  (SELECT seller_address FROM public.moment_acquisitions WHERE nft_id = 'n1'),
  '0xSELL1',
  'seller_address carries the trade counterparty'
);

-- ── 5. AN EMPTY transaction_id IS SYNTHESIZED, NOT LEFT BLANK ───────────────
-- A blank transaction_hash would collide on the (nft_id, wallet, tx) conflict
-- key with any other blank-tx row for the same Pin and wallet.
SELECT _assert_eq(
  (SELECT transaction_hash FROM public.moment_acquisitions WHERE nft_id = 'n2'),
  'pinnacle_trade:n2',
  'an empty transaction_id is synthesized to a per-Pin key'
);

-- ── 6. COLLECTION SCOPING ───────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id = 'n3'),
  '0',
  'a wmc row in a different collection does not produce a Pinnacle trade acquisition'
);

-- ── 7. IDEMPOTENCE ──────────────────────────────────────────────────────────
-- The lane re-reads block ranges on any partial tick, so the backfill runs
-- against the same trade rows repeatedly. A second run must insert nothing.
SELECT _assert_eq(
  (public.backfill_pinnacle_trade_acquisitions() ->> 'inserted'), '0',
  'a re-run over unchanged trade rows inserts nothing — ON CONFLICT makes it idempotent'
);

ROLLBACK;
