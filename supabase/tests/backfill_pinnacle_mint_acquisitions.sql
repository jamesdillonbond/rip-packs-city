-- DB invariant: public.backfill_pinnacle_mint_acquisitions — pg_cron
-- `rpc-backfill-pinnacle-mint-acquisitions` @ `19 * * * *`.
--
-- WHY IT MATTERS. It writes `moment_acquisitions`, the COST BASIS table. Every
-- P&L figure a Pinnacle collector sees on their own moments derives from these
-- rows (`resolveMomentPnlBasis()`, the Cost and P&L columns in
-- CollectionMomentTable). A defect here does not throw — it shows a collector the
-- wrong profit on their own collection.
--
-- THE THREE PROPERTIES, and the first is the one that would be most tempting to
-- "tidy up":
--
--   1. ⚠ A MINT WRITES NO buy_price. The column is simply absent from the INSERT
--      column list, so it lands NULL. A mint has no purchase price, and
--      defaulting it to 0 would render the moment as 100% profit forever — a
--      confidently wrong number on the collector's own portfolio. Asserted
--      explicitly because "the column is missing from the list" reads like an
--      oversight to anyone reading the INSERT.
--   2. ⚠ THE NOT EXISTS GATE IS SCOPED ON nft_id ALONE, not (nft_id, wallet).
--      A mint is the FIRST acquisition of a moment, so once ANY acquisition row
--      exists for that nft_id the mint must not be inserted retroactively behind
--      it. Narrowing the gate to (nft_id, wallet) — which looks like a bug fix,
--      since the table's conflict key is the triple — would let a mint row
--      appear beneath a later marketplace purchase by a DIFFERENT wallet, giving
--      that moment two "first" acquisitions.
--   3. The wallet join is CASE-INSENSITIVE (`lower(...) = lower(...)`). Flow
--      addresses arrive in mixed case from different indexers, and a
--      case-sensitive join silently backfills nothing while reporting ok.
--
-- ⚠ Deliberately NOT asserted: that `inserted` equals the number of candidate
-- rows. It counts rows the INSERT actually returned, so a row suppressed by
-- ON CONFLICT is correctly excluded — the count is the honest one.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816003000_audit_20260816_snapshot_pinnacle_acquisition_backfills.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 551b9c90e4659c01514dddfe0673ffef).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_mint_events (
  nft_id    text,
  to_wallet text,
  minted_at timestamptz,
  tx_hash   text
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

-- >>> BEGIN verbatim backfill_pinnacle_mint_acquisitions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_pinnacle_mint_acquisitions(p_limit integer DEFAULT 50000)
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
    SELECT m.nft_id,
           wmc.wallet_address AS wallet,
           m.minted_at        AS acquired_date,
           COALESCE(NULLIF(m.tx_hash, ''), 'pinnacle_mint:' || m.nft_id) AS tx_hash
    FROM public.pinnacle_mint_events m
    JOIN public.wallet_moments_cache wmc
      ON wmc.moment_id = m.nft_id
     AND wmc.collection_id = v_pin
     AND lower(wmc.wallet_address) = lower(m.to_wallet)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.moment_acquisitions a WHERE a.nft_id = m.nft_id
    )
    LIMIT p_limit
  ),
  ins AS (
    INSERT INTO public.moment_acquisitions (
      nft_id, wallet, acquired_date, acquired_type,
      acquisition_method, acquisition_confidence,
      transaction_hash, source, collection_id
    )
    SELECT
      nft_id, wallet, acquired_date, 1,
      'mint', 'verified',
      tx_hash, 'pinnacle_mints', v_pin
    FROM candidates
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins INTO v_inserted;

  RETURN json_build_object('collection', 'disney_pinnacle', 'inserted', v_inserted);
END;
$function$;
-- <<< END verbatim backfill_pinnacle_mint_acquisitions <<<

\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set OTHER '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.pinnacle_mint_events (nft_id, to_wallet, minted_at, tx_hash) VALUES
  ('n1', '0xAAAA', '2026-05-01T00:00:00Z', 'tx1'),   -- plain mint
  ('n2', '0xBBBB', '2026-05-02T00:00:00Z', ''),      -- empty tx_hash -> synthesized
  ('n3', '0xCCCC', '2026-05-03T00:00:00Z', 'tx3'),   -- already has an acquisition -> skipped
  ('n4', '0xDDDD', '2026-05-04T00:00:00Z', 'tx4'),   -- wmc row is a DIFFERENT collection
  ('n5', '0xeeee', '2026-05-05T00:00:00Z', 'tx5');   -- case differs between the two tables

INSERT INTO public.wallet_moments_cache (moment_id, wallet_address, collection_id) VALUES
  ('n1', '0xAAAA', :PIN::uuid),
  ('n2', '0xBBBB', :PIN::uuid),
  ('n3', '0xCCCC', :PIN::uuid),
  ('n4', '0xDDDD', :OTHER::uuid),
  ('n5', '0xEEEE', :PIN::uuid);

-- n3 already has an acquisition — from a DIFFERENT wallet and tx, so the
-- conflict key would NOT stop it. Only the nft_id-scoped NOT EXISTS does.
INSERT INTO public.moment_acquisitions
  (nft_id, wallet, buy_price, acquired_date, acquired_type, acquisition_method,
   acquisition_confidence, transaction_hash, source, collection_id)
VALUES
  ('n3', '0xZZZZ', 42.00, '2026-06-01T00:00:00Z', 1, 'marketplace', 'verified',
   'tx-later', 'pinnacle_sales_join_wmc', :PIN::uuid);

SELECT _assert_eq(
  (public.backfill_pinnacle_mint_acquisitions() ->> 'inserted'), '3',
  'n1, n2 and n5 are inserted; n3 is gated by NOT EXISTS and n4 by collection'
);

-- ── 1. A MINT MUST NOT CARRY A COST BASIS ───────────────────────────────────
-- ⚠ The single most important assertion in this file. A 0 here renders as a
-- 100%-profit moment on the collector's own portfolio, forever.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions
    WHERE source = 'pinnacle_mints' AND buy_price IS NOT NULL),
  '0',
  'a mint has no purchase price — buy_price must be NULL, never 0'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions
    WHERE source = 'pinnacle_mints' AND acquisition_method = 'mint'
      AND acquisition_confidence = 'verified' AND acquired_type = 1),
  '3',
  'every mint row is labelled mint/verified'
);

-- ── 2. THE nft_id-SCOPED GATE ───────────────────────────────────────────────
-- ⚠ n3's pre-existing row is a DIFFERENT (wallet, tx), so ON CONFLICT cannot
-- suppress it. If the NOT EXISTS were narrowed to (nft_id, wallet) — which looks
-- like a fix, since the table's conflict key is the triple — n3 would gain a
-- second "first" acquisition beneath a later marketplace purchase.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id = 'n3'),
  '1',
  'a moment that already has ANY acquisition never gains a retroactive mint'
);

SELECT _assert_eq(
  (SELECT source FROM public.moment_acquisitions WHERE nft_id = 'n3'),
  'pinnacle_sales_join_wmc',
  'and the pre-existing row is left exactly as it was'
);

-- ── 3. CASE-INSENSITIVE WALLET JOIN ─────────────────────────────────────────
-- Flow addresses arrive in mixed case from different indexers. A case-sensitive
-- join silently backfills nothing while still reporting ok.
SELECT _assert_eq(
  (SELECT wallet FROM public.moment_acquisitions WHERE nft_id = 'n5'),
  '0xEEEE',
  'the wallet join is case-insensitive, and the wmc spelling is what is stored'
);

-- ── 4. Collection scope + tx_hash synthesis ─────────────────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE nft_id = 'n4'),
  '0',
  'a wmc row in another collection is out of scope'
);

SELECT _assert_eq(
  (SELECT transaction_hash FROM public.moment_acquisitions WHERE nft_id = 'n2'),
  'pinnacle_mint:n2',
  'an EMPTY tx_hash is synthesized, not left blank — blank would collide on the conflict key'
);

-- ── 5. RE-RUNNING IS A NO-OP ────────────────────────────────────────────────
-- ⚠ It runs hourly, so idempotence is the property that keeps the table from
-- growing a duplicate cost-basis row every hour. Note this now exercises BOTH
-- suppressors: the NOT EXISTS gate (the rows it just wrote now exist) and, were
-- that removed, ON CONFLICT behind it.
SELECT _assert_eq(
  (public.backfill_pinnacle_mint_acquisitions() ->> 'inserted'), '0',
  'a second run inserts nothing'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions), '4',
  'and the table is unchanged (3 mints + the pre-existing marketplace row)'
);

-- ── 6. p_limit is honoured ──────────────────────────────────────────────────
-- The hourly job passes the default, but the bound is what stops one tick
-- holding a 90s statement budget open across an unbounded backlog.
DELETE FROM public.moment_acquisitions WHERE source = 'pinnacle_mints';

SELECT _assert_eq(
  (public.backfill_pinnacle_mint_acquisitions(1) ->> 'inserted'), '1',
  'p_limit bounds one run'
);

ROLLBACK;
