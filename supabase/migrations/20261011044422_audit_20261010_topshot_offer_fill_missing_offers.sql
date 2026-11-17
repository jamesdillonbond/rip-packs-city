-- audit_20261010_topshot_offer_fill_missing_offers
-- anon-exec: n/a — no function created or replaced; a snapshot table.
--
-- 2026-10-10 (PT). With sales.offer_id on every Top Shot offer_fill sale, 21,367 fills
-- name an offer that has NO offers row: the indexer never recorded its OfferAvailable
-- (an unplaceable serial offer, a range lost to the pre-08-21 cursor bug, or a creation
-- older than the history walk's lookback). This table is the exact set to recover —
-- one row per missing offer, carrying what the fill already proves (fill tx, time,
-- buyer, price, the sale's edition + serial). /api/admin/backfill-topshot-missing-fill-offers
-- walks OfferAvailable from the mainnet28 root and inserts an offers row for each one it
-- finds (status 'filled', created_at = the OfferAvailable block time). Rows are never
-- deleted here; `recovered` is derived by joining offers.
--
-- RLS on, no grants: service_role (the route) only.
-- Revert: DROP TABLE public.topshot_offer_fill_missing_offers;

CREATE TABLE IF NOT EXISTS public.topshot_offer_fill_missing_offers (
  offer_id        text PRIMARY KEY,
  fill_tx         text NOT NULL,
  sold_at         timestamptz NOT NULL,
  edition_id      uuid,
  serial_number   integer,
  buyer_address   text,
  price_usd       numeric,
  snapshot_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.topshot_offer_fill_missing_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_offer_fill_missing_offers FROM PUBLIC, anon, authenticated;

INSERT INTO public.topshot_offer_fill_missing_offers (offer_id, fill_tx, sold_at, edition_id, serial_number, buyer_address, price_usd)
SELECT DISTINCT ON (s.offer_id) s.offer_id, s.transaction_hash, s.sold_at, s.edition_id, s.serial_number, s.buyer_address, s.price_usd
FROM public.sales s
WHERE s.source = 'offer_fill'
  AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  AND s.offer_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.offers o WHERE o.offer_id = s.offer_id)
ORDER BY s.offer_id, s.sold_at
ON CONFLICT (offer_id) DO NOTHING;
