-- Supports the per-wallet best-offer join added to /api/best-offers for the
-- non-TopShot Flow collections (AllDay/UFC/Golazos): the offer feed
-- marketplace_offers is keyed only by nft_id (= the moment_id) and had NO index
-- on nft_id/collection_id (only edition_id, which is NULL on every row), so a
-- `WHERE collection_id=? AND offer_state='LISTED' AND nft_id IN (...)` lookup
-- seq-scanned all 14 partitions. Partial (LISTED-only) keeps it small (~60k rows)
-- and off the write path for the CANCELLED/other churn.
--
-- Revert: DROP INDEX IF EXISTS public.idx_marketplace_offers_listed_coll_nft;
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_listed_coll_nft
  ON public.marketplace_offers (collection_id, nft_id)
  WHERE offer_state = 'LISTED';
