-- audit_20261010_offers_open_rows_that_filled
-- anon-exec: n/a — no function created or replaced; an audit table + a one-off UPDATE.
--
-- 2026-10-10 (PT). With sales.offer_id stamped on all 81,574 Top Shot offer_fill sales
-- (20261011001215 + the offers history walk), 45 fills point at an offers row still
-- 'open': the completion flip never landed on them. Their fill sale is the on-chain
-- proof (OfferCompleted purchased=true carries this offerId), so they are flipped to
-- 'filled' with resolved_at = the sale's sold_at and fill_tx_hash = the sale's tx.
-- Open rows feed best-offer / bid-depth readers (status='open'), so a filled offer left
-- open was a dead bid on display.
--
-- Revert: UPDATE public.offers o SET status = a.old_status, resolved_at = a.old_resolved_at,
--           fill_tx_hash = a.old_fill_tx_hash
--         FROM public.audit_20261010_offers_open_rows_that_filled a WHERE o.offer_id = a.offer_id;

CREATE TABLE IF NOT EXISTS public.audit_20261010_offers_open_rows_that_filled AS
SELECT o.offer_id, o.status AS old_status, o.resolved_at AS old_resolved_at,
       o.fill_tx_hash AS old_fill_tx_hash, s.transaction_hash AS sale_tx, s.sold_at AS sale_sold_at,
       now() AS audited_at
FROM public.offers o
JOIN public.sales s ON s.offer_id = o.offer_id
 AND s.source = 'offer_fill'
 AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
WHERE o.status = 'open'
  AND o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid;

ALTER TABLE public.audit_20261010_offers_open_rows_that_filled ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261010_offers_open_rows_that_filled FROM PUBLIC, anon, authenticated;

UPDATE public.offers o
SET status = 'filled', resolved_at = a.sale_sold_at, fill_tx_hash = COALESCE(o.fill_tx_hash, a.sale_tx)
FROM public.audit_20261010_offers_open_rows_that_filled a
WHERE o.offer_id = a.offer_id AND o.status = 'open';
