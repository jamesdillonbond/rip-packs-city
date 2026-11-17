-- 2026-11-04 (Claude Code cloud) — class 2 backup: atlas_backfill Top Shot "sales" whose SELLER KEPT THE MOMENT.
--
-- Companion to 20261104224945 (class 1: 4,361 rows proven cancelled by Atlas's own `purchased = false`).
-- The other 2,228 atlas_backfill rows match no cancelled listing-end, mostly because their Atlas events are
-- gone. A second, independent instrument: a real sale changes the owner, so the NFT's NEXT real sale (any
-- source but atlas_backfill) is by someone else, and the seller does not hold it today.
--   next real sale is by the SAME seller:  on-chain control 1 / 153 (0.6 %) · class 1 2,034 / 2,051 (99.2 %)
--   no later sale, seller still owns it (topshot_ownership, walk-confirmed): control 0 / 228 · class 1 168 / 241
-- This table: atlas_backfill, buyer NULL, NOT in class 1, NO purchased Atlas listing within ±2 min, and either
-- the next real sale's seller = this row's seller (976) or no later sale and the seller still owns it (60).
-- Measured 1,036 rows, $75,039. Everything else (~1,190 rows) stays: unprovable.
--
-- Revert: DROP TABLE public.audit_20261104_atlas_backfill_seller_kept_moment_sales;

CREATE TABLE public.audit_20261104_atlas_backfill_seller_kept_moment_sales AS
SELECT s.*
  FROM public.sales s
 WHERE s.source = 'atlas_backfill'
   AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND s.buyer_address IS NULL
   AND s.id NOT IN (SELECT id FROM public.audit_20261104_atlas_backfill_cancelled_listing_sales)
   AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events e
                    WHERE e.nft_id = s.nft_id AND e.product = 'nba' AND e.kind = 'listing' AND e.purchased
                      AND e.purchased_at BETWEEN s.sold_at - interval '2 minutes' AND s.sold_at + interval '2 minutes')
   AND (
     (SELECT s2.seller_address FROM public.sales s2
       WHERE s2.collection_id = s.collection_id AND s2.nft_id = s.nft_id AND s2.source <> 'atlas_backfill'
         AND s2.sold_at > s.sold_at + interval '2 minutes' AND s2.seller_address IS NOT NULL
       ORDER BY s2.sold_at LIMIT 1) = s.seller_address
     OR (NOT EXISTS (SELECT 1 FROM public.sales s2
                      WHERE s2.collection_id = s.collection_id AND s2.nft_id = s.nft_id AND s2.source <> 'atlas_backfill'
                        AND s2.sold_at > s.sold_at + interval '2 minutes')
         AND EXISTS (SELECT 1 FROM public.topshot_ownership o
                      WHERE o.nft_id = s.nft_id AND o.walk_missed_at IS NULL
                        AND lower(o.owner_address) = lower(s.seller_address)))
   );

ALTER TABLE public.audit_20261104_atlas_backfill_seller_kept_moment_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261104_atlas_backfill_seller_kept_moment_sales FROM PUBLIC, anon, authenticated;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261104_atlas_backfill_seller_kept_moment_sales;
  IF n < 1000 OR n > 1080 THEN
    RAISE EXCEPTION 'expected ~1,036 seller-kept-moment sales, got %', n;
  END IF;
END $$;
