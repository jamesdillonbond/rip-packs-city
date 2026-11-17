-- Disney Pinnacle TRADING — the third Pinnacle transaction type.
--
-- Until this migration, Pinnacle had exactly two tracked transaction types:
--   • storefront SALE  → pinnacle_sales      (NFTStorefrontV2.ListingCompleted)
--   • primary MINT     → pinnacle_mint_events(Pinnacle.PinNFTMinted + same-tx Deposit)
-- Pinnacle's in-app peer-to-peer TRADE produced neither, so a traded Pin left no
-- record anywhere: no sale row, no mint row, and no moment_acquisitions row. It
-- surfaced only as a silent owner flip in pinnacle_ownership_snapshots (a
-- latest-owner MAP, not an event log — it carries no counterparty and no tx).
--
-- ⚠ THE ON-CHAIN SHAPE WAS MEASURED, NOT ASSUMED (2026-08-22, via pg_net against
-- Flow REST; two independent 10,000-block windows, ~3.5 h of chain each):
--
--   window A  162,163,000–162,172,999 : 53 sale-shaped tx, 9 TRADE tx (54 Pins)
--   window B  162,153,000–162,162,999 : 26 sale-shaped tx, 5 TRADE tx (23 Pins)
--
-- A Pinnacle trade settles as ONE atomic transaction in which EXACTLY TWO wallets
-- swap Pins in BOTH directions: the union of Withdraw.from and Deposit.to is two
-- addresses, and each address appears on BOTH sides. A storefront sale can never
-- take that shape — its seller appears only as `from` and its buyer only as `to`.
-- A mint emits a Deposit with NO Withdraw at all, so requiring a Withdraw excludes
-- it by construction (the same exclusion ingest-pinnacle-mints already relies on
-- in the opposite direction).
--
-- The classifier was then validated in BOTH directions against per-transaction
-- ground truth (/v1/transaction_results, which lists every event in the tx):
--   geometry=TRADE      → 14 tx / 77 Pins → storefront events present in 0
--   geometry=NOT-trade  → 26 tx / 26 Pins → storefront events present in 26
-- Zero false positives, zero false negatives, across both windows.
--
-- ⚠ SIZE OF WHAT WAS MISSING: across those two windows 77 Pins moved by TRADE
-- against 79 Pins moved by storefront SALE — very close to 1:1. Every Pinnacle
-- "market activity" figure the platform publishes today counts only the second
-- half of that, so this is not a long-tail gap.
--
-- ⚠ A TRADE HAS NO PRICE, AND THIS MIGRATION NEVER INVENTS ONE. The acquisition
-- path below omits buy_price from its INSERT column list entirely — exactly the
-- asymmetry backfill_pinnacle_mint_acquisitions already encodes, and for the same
-- reason: defaulting it to 0 renders a 100%-profit moment forever. Downstream,
-- resolveMomentPnlBasis() only trusts a "Bought"/"Loan" label as a cost basis, so
-- the new "Traded" label yields no P&L rather than a fabricated one.
--
-- REVERT (data half; the code half is `git revert <sha>`):
--   SELECT cron.unschedule('rpc-backfill-pinnacle-trade-acquisitions');
--   DELETE FROM public.moment_acquisitions WHERE source = 'pinnacle_trades';
--   DROP FUNCTION public.backfill_pinnacle_trade_acquisitions(integer);
--   ALTER TABLE public.moment_acquisitions DROP CONSTRAINT chk_acquisition_method;
--   ALTER TABLE public.moment_acquisitions ADD CONSTRAINT chk_acquisition_method
--     CHECK (acquisition_method = ANY (ARRAY['marketplace','pack_pull','loan_default',
--       'gift','challenge_reward','airdrop','unknown','flowty_purchase','offer_accepted','mint']));
--   DROP TABLE public.pinnacle_trade_events;
--   DELETE FROM public.event_cursor WHERE id = 'pinnacle_trades';

-- ── 1. The event table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pinnacle_trade_events (
  -- '{transaction_id}_{nft_id}', mirroring pinnacle_sales.id, so a re-scan of a
  -- block range is idempotent under ON CONFLICT DO NOTHING.
  id              text        PRIMARY KEY,
  transaction_id  text        NOT NULL,
  nft_id          text        NOT NULL,
  -- Pinnacle edition_key. NULL until pinnacle_nft_map covers the Pin; backfills
  -- later exactly as pinnacle_sales.edition_id does. NULL means "we cannot name
  -- it yet", never "it has no edition".
  edition_id      text,
  from_wallet     text        NOT NULL,
  to_wallet       text        NOT NULL,
  traded_at       timestamptz NOT NULL,
  block_height    bigint      NOT NULL,
  -- Total Pins moved by the WHOLE swap transaction. A 25-Pin swap writes 25 rows
  -- that are one trade, not 25 trades; without this column a naive count(*) would
  -- report trade VOLUME as trade COUNT. Observed sizes: 2,2,2,2,2,3,7,11,25.
  pins_in_trade   int         NOT NULL,
  source          text        NOT NULL DEFAULT 'on-chain',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pinnacle_trade_events_distinct_parties CHECK (from_wallet <> to_wallet),
  CONSTRAINT pinnacle_trade_events_pins_positive    CHECK (pins_in_trade > 0)
);

CREATE INDEX IF NOT EXISTS pinnacle_trade_events_traded_at_idx  ON public.pinnacle_trade_events (traded_at DESC);
CREATE INDEX IF NOT EXISTS pinnacle_trade_events_nft_id_idx     ON public.pinnacle_trade_events (nft_id);
CREATE INDEX IF NOT EXISTS pinnacle_trade_events_to_wallet_idx  ON public.pinnacle_trade_events (to_wallet, traded_at DESC);
CREATE INDEX IF NOT EXISTS pinnacle_trade_events_from_wallet_idx ON public.pinnacle_trade_events (from_wallet, traded_at DESC);
CREATE INDEX IF NOT EXISTS pinnacle_trade_events_tx_idx         ON public.pinnacle_trade_events (transaction_id);
CREATE INDEX IF NOT EXISTS pinnacle_trade_events_edition_id_idx ON public.pinnacle_trade_events (edition_id) WHERE edition_id IS NOT NULL;

-- Security posture copied from pinnacle_mint_events: RLS on with NO policies, so
-- anon/authenticated can read nothing; service_role bypasses RLS for the ingest.
-- Revoked FROM PUBLIC, anon, authenticated in ONE statement because this DB
-- carries both a PUBLIC default and ALTER DEFAULT PRIVILEGES grants.
ALTER TABLE public.pinnacle_trade_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_trade_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pinnacle_trade_events TO postgres, service_role;

-- ── 2. Cursor ───────────────────────────────────────────────────────────────
-- Seeded at 162,153,000 — the floor of measurement window B — rather than at the
-- sealed tip. That hands the first ticks ~21,000 blocks (~7 h) of real history
-- AND makes them re-derive the two hand-verified windows, so the lane's first
-- output is checkable against a number measured before it existed:
--   162,153,000–162,162,999 must yield 5 trades / 23 Pins
--   162,163,000–162,172,347 must yield 9 trades / 54 Pins
-- Deeper history is a separate backfill workstream (walk DOWN from this floor).
INSERT INTO public.event_cursor (id, last_processed_block, updated_at)
VALUES ('pinnacle_trades', 162153000, now())
ON CONFLICT (id) DO NOTHING;

-- ── 3. Widen the acquisition-method vocabulary ──────────────────────────────
ALTER TABLE public.moment_acquisitions DROP CONSTRAINT IF EXISTS chk_acquisition_method;
ALTER TABLE public.moment_acquisitions ADD CONSTRAINT chk_acquisition_method
  CHECK (acquisition_method = ANY (ARRAY[
    'marketplace'::text, 'pack_pull'::text, 'loan_default'::text, 'gift'::text,
    'challenge_reward'::text, 'airdrop'::text, 'unknown'::text,
    'flowty_purchase'::text, 'offer_accepted'::text, 'mint'::text,
    'trade'::text
  ]));

-- ── 4. Trade → acquisition backfill ─────────────────────────────────────────
-- Deliberately parallel to backfill_pinnacle_acquisitions (marketplace), with two
-- differences, both load-bearing:
--   • NO buy_price column in the INSERT. A trade has no cash price.
--   • NO nft_id-scoped NOT EXISTS guard (that one belongs to the MINT path, where
--     it stops a mint being inserted retroactively beneath a later purchase). A
--     Pin legitimately trades many times, so this is one row per (wallet, tx),
--     deduped by the ON CONFLICT — the marketplace path's discipline, not the
--     mint path's.
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

REVOKE EXECUTE ON FUNCTION public.backfill_pinnacle_trade_acquisitions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_pinnacle_trade_acquisitions(integer) TO postgres, service_role;

-- ── 5. Schedule ─────────────────────────────────────────────────────────────
-- Owned by cron_heavy and offset off the two sibling Pinnacle acquisition
-- backfills (17 */6 marketplace, 19 */3 mint) so the three never collide.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-backfill-pinnacle-trade-acquisitions') THEN
    PERFORM cron.unschedule('rpc-backfill-pinnacle-trade-acquisitions');
  END IF;
END $$;

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-backfill-pinnacle-trade-acquisitions',
  '23 */3 * * *',
  'SELECT public.backfill_pinnacle_trade_acquisitions(50000)'
);
RESET ROLE;
