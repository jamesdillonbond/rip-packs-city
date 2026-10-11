-- audit_20261010_sales_offer_id_for_offer_fills
-- anon-exec: n/a — no function created or replaced; a nullable column on a table.
--
-- 2026-10-10 (PT). An offer_fill sale (source='offer_fill') is a Dapper OffersV2
-- OfferCompleted(purchased=true). It carried the fill tx but NOT the offer it filled,
-- so a fill could only be joined to its `offers` row through offers.fill_tx_hash —
-- which is stamped only where the indexer saw the offer's creation. ~20,000 fills since
-- 06-03 have no offers row, and 3,122 of the 4,204 since 09-01 sit beside an OPEN row
-- of the same buyer + price: either a missed completion flip or offers that expire with
-- no OfferCompleted. Carrying the on-chain offerId on the sale settles which.
--
-- Nullable, no default: metadata-only on the partitioned parent and its partitions.
-- Written by lib/chains/flow/topshot-offer-fill.ts (buildOfferFillSales) going forward;
-- history stamped by /api/admin/backfill-offer-fill-sales re-walking OfferCompleted.
-- No index: the join runs sales -> offers on uq_offers_offer_id.
--
-- Revert: ALTER TABLE public.sales DROP COLUMN offer_id;

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS offer_id text;

COMMENT ON COLUMN public.sales.offer_id IS
  'On-chain OffersV2 offerId for source=offer_fill sales (the offer this sale filled); NULL for every other source.';
