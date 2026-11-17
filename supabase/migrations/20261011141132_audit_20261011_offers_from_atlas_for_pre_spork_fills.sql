-- audit_20261011_offers_from_atlas_for_pre_spork_fills
-- anon-exec: n/a — no function created or replaced; a one-off INSERT.
--
-- 2026-10-11 (PT). 4,115 Top Shot offer_fill sales still name an offerId with no
-- offers row after the OfferAvailable walk (20261011044422): their OfferAvailable
-- is not in mainnet28, so the offer was created before the 2025-12-29 spork,
-- beyond rest-mainnet's reach. For 877 of them Top Shot's own marketplace feed
-- (topshot_atlas_market_events, kind='offer') holds the purchased offer: same nft,
-- same price, purchased within 15 minutes of the fill — and exactly ONE such event
-- (0 multi-matches; the rest have no Atlas event and stay unrecovered).
-- The row is built from what is PROVEN, with provenance in `source`:
--   offer_id = the on-chain offerId the fill sale carries (sales.offer_id)
--   created_at = Atlas listed_at (marketplace-reported, hence source 'atlas_backfill')
--   resolved_at / fill_tx_hash / buyer / amount / edition / serial = the fill sale
--   offer_type = Atlas offer_type (EDITION→edition, SERIAL→serial, PARALLEL→subedition)
--   tx_hash = NULL (the creation tx is not known — never invented)
-- Insert-only (ON CONFLICT DO NOTHING), and only where listed_at precedes the fill.
--
-- Revert: DELETE FROM public.offers WHERE source = 'atlas_backfill';

WITH m AS (
  SELECT mo.offer_id, s.transaction_hash, s.nft_id, s.price_usd, s.sold_at, s.buyer_address,
         s.edition_id, s.serial_number
  FROM public.topshot_offer_fill_missing_offers mo
  JOIN public.sales s
    ON s.transaction_hash = mo.fill_tx
   AND s.source = 'offer_fill'
   AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  WHERE NOT EXISTS (SELECT 1 FROM public.offers o WHERE o.offer_id = mo.offer_id)
), cand AS (
  SELECT m.*, a.listed_at, a.offer_type AS atlas_type,
         count(*) OVER (PARTITION BY m.offer_id) AS n_match
  FROM m
  JOIN public.topshot_atlas_market_events a
    ON a.nft_id = m.nft_id
   AND a.product = 'nba'
   AND a.kind = 'offer'
   AND a.purchased
   AND a.price_cents = round(m.price_usd * 100)
   AND a.purchased_at BETWEEN m.sold_at - interval '15 minutes' AND m.sold_at + interval '15 minutes'
)
INSERT INTO public.offers (offer_id, tx_hash, collection_id, edition_id, moment_id, serial_number,
                           offer_amount_usd, buyer_address, offer_type, source, status,
                           created_at, resolved_at, fill_tx_hash)
SELECT c.offer_id, NULL, '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, c.edition_id, NULL,
       CASE WHEN c.atlas_type = 'SERIAL' THEN c.serial_number END,
       c.price_usd, c.buyer_address,
       CASE c.atlas_type WHEN 'EDITION' THEN 'edition' WHEN 'SERIAL' THEN 'serial' WHEN 'PARALLEL' THEN 'subedition' END,
       'atlas_backfill', 'filled', c.listed_at, c.sold_at, c.transaction_hash
FROM cand c
WHERE c.n_match = 1
  AND c.listed_at IS NOT NULL
  AND c.listed_at < c.sold_at
  AND c.atlas_type IN ('EDITION', 'SERIAL', 'PARALLEL')
ON CONFLICT (offer_id) DO NOTHING;
