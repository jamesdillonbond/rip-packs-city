-- audit_20260918_pack_purchases_seller_backfilled_from_marketplace_history
--
-- WHAT IS WRONG. `pack_purchases.seller_address` is the transaction PAYER, and
-- on Dapper's marketplace that is the escrow account 0x18eb4ee6b3c026d2 on
-- 103,425 Top Shot + 2,107 All Day secondary rows (measured 2026-09-18). The
-- wallet RPCs now route around it (20260919004500), but every OTHER reader of
-- the column — the pack lifecycle ownership chain, wallet-usernames scans that
-- exclude the escrow, the admin buyer backfills — still sees a seller that
-- names nobody. The worker fix (seller = same-tx PackNFT.Withdraw.from) only
-- helps rows ingested after its deploy.
--
-- WHAT THIS DOES. For each escrow-seller secondary row, find the marketplace
-- history row for the SAME pack and the SAME buyer whose sale time falls in
-- [sealed_at - 30 days, sealed_at + 1 day] (on-chain settlement trails the
-- marketplace sale by a median 4 h and a p90 of 9 days — 31,995 matched pairs)
-- and take its storefront_address as the seller — ONLY when exactly one
-- distinct seller matches. Measured before applying:
--   Top Shot: 103,425 escrow rows → 67,334 matched, 67,215 with ONE seller, 119 ambiguous (left alone)
--   All Day:    2,107 escrow rows →  1,674 matched,  1,674 with ONE seller,   0 ambiguous
-- Every change is recorded first in audit_20260918_pack_purchases_seller_backfill
-- (row id, old seller, new seller, the marketplace row that justified it), so
-- the mutation is reversible row-for-row.
--
-- NOT touched: primary_withdraw / primary_mint rows (their seller is the contract
-- reserve / NULL by design), rows with 0 or >1 candidate sellers, and the
-- is_primary_drop flag (its trigger keys on the primary_drop_forwarders
-- registry; a user wallet never matches, and event_kind is the classifier).
--
-- REVERT:
--   UPDATE public.pack_purchases pp SET seller_address = a.old_seller
--   FROM public.audit_20260918_pack_purchases_seller_backfill a WHERE a.pack_purchase_id = pp.id;
-- (the audit table stays; it is the record of what was inferred and from what).

CREATE TABLE IF NOT EXISTS public.audit_20260918_pack_purchases_seller_backfill (
  pack_purchase_id uuid PRIMARY KEY,
  collection_id    uuid NOT NULL,
  pack_nft_id      text NOT NULL,
  old_seller       text,
  new_seller       text NOT NULL,
  source_tx_hash   text NOT NULL,
  source_block_time timestamptz NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260918_pack_purchases_seller_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260918_pack_purchases_seller_backfill FROM PUBLIC, anon, authenticated;

-- 1. Record every unambiguous inference (idempotent: PK on the purchase row).
INSERT INTO public.audit_20260918_pack_purchases_seller_backfill
  (pack_purchase_id, collection_id, pack_nft_id, old_seller, new_seller, source_tx_hash, source_block_time)
SELECT m.id, m.collection_id, m.pack_nft_id, m.seller_address, m.new_seller, m.source_tx_hash, m.source_block_time
FROM (
  SELECT pp.id, pp.collection_id, pp.pack_nft_id, pp.seller_address,
         MIN(h.storefront_address) AS new_seller,
         COUNT(DISTINCT h.storefront_address) AS sellers,
         (array_agg(h.tx_hash ORDER BY h.block_time DESC))[1] AS source_tx_hash,
         MAX(h.block_time) AS source_block_time
  FROM public.pack_purchases pp
  JOIN public.topshot_pack_sales_history h
    ON h.pack_nft_id = pp.pack_nft_id
   AND h.purchased
   AND h.buyer_address = pp.buyer_address
   AND h.block_time BETWEEN pp.sealed_at - interval '30 days' AND pp.sealed_at + interval '1 day'
  WHERE pp.event_kind = 'secondary_sale'
    AND pp.seller_address = '0x18eb4ee6b3c026d2'
    AND pp.collection_id = (SELECT id FROM public.collections WHERE slug = 'nba_top_shot')
  GROUP BY pp.id, pp.collection_id, pp.pack_nft_id, pp.seller_address
) m
WHERE m.sellers = 1
  AND m.new_seller ~ '^0x[0-9a-f]{16}$'
  AND m.new_seller <> '0x18eb4ee6b3c026d2'
ON CONFLICT (pack_purchase_id) DO NOTHING;

INSERT INTO public.audit_20260918_pack_purchases_seller_backfill
  (pack_purchase_id, collection_id, pack_nft_id, old_seller, new_seller, source_tx_hash, source_block_time)
SELECT m.id, m.collection_id, m.pack_nft_id, m.seller_address, m.new_seller, m.source_tx_hash, m.source_block_time
FROM (
  SELECT pp.id, pp.collection_id, pp.pack_nft_id, pp.seller_address,
         MIN(h.storefront_address) AS new_seller,
         COUNT(DISTINCT h.storefront_address) AS sellers,
         (array_agg(h.tx_hash ORDER BY h.block_time DESC))[1] AS source_tx_hash,
         MAX(h.block_time) AS source_block_time
  FROM public.pack_purchases pp
  JOIN public.allday_pack_sales_history h
    ON h.pack_nft_id = pp.pack_nft_id
   AND h.purchased
   AND h.buyer_address = pp.buyer_address
   AND h.block_time BETWEEN pp.sealed_at - interval '30 days' AND pp.sealed_at + interval '1 day'
  WHERE pp.event_kind = 'secondary_sale'
    AND pp.seller_address = '0x18eb4ee6b3c026d2'
    AND pp.collection_id = (SELECT id FROM public.collections WHERE slug = 'nfl_all_day')
  GROUP BY pp.id, pp.collection_id, pp.pack_nft_id, pp.seller_address
) m
WHERE m.sellers = 1
  AND m.new_seller ~ '^0x[0-9a-f]{16}$'
  AND m.new_seller <> '0x18eb4ee6b3c026d2'
ON CONFLICT (pack_purchase_id) DO NOTHING;

-- 2. Apply, keyed by the audit rows, only where the row still carries the escrow.
UPDATE public.pack_purchases pp
SET seller_address = a.new_seller
FROM public.audit_20260918_pack_purchases_seller_backfill a
WHERE a.pack_purchase_id = pp.id
  AND pp.seller_address = '0x18eb4ee6b3c026d2';
