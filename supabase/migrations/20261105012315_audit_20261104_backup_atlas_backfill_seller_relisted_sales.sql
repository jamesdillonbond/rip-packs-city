-- 2026-11-04 (Claude Code cloud) — class 3 backup: atlas_backfill Top Shot "sales" whose SELLER RELISTED (or later
-- sold) THE SAME NFT. Read only; the delete is staged separately (the connector's destructive confirm times out).
--
-- Classes 1 and 2 (20261104224945, 20261104233041) were deleted 11-04 (20261105010616). Class 2 keyed "seller kept
-- it" on the NEXT REAL SALE or current ownership; it could not see an NFT the seller merely RE-LISTED. After that
-- delete, 8 atlas_backfill rows were still in the top 100 Top Shot sales by price in 90 days ($7,499, $7,297,
-- $7,036, $6,000, ...): every one buyer NULL, no purchased Atlas listing, and the SAME seller listing the SAME NFT
-- again afterwards (6 of 8 within ~1-2 min of the "sale" -- a reprice, not a sale).
--   same seller lists the NFT again after the sale, 08-10..09-10:  onchain 82 / 62,295 (0.13 %) · atlas 47 / 17,489
--     (0.27 %) · offer_fill 6 / 18,038 · atlas_backfill 714 / 1,192 (60 %)
--   a later sale by the same seller, 08-10..08-20:  onchain 20 / 28,264 (0.07 %) · atlas 1 / 4,897 · atlas_backfill 60 / 366
-- This table: atlas_backfill, buyer NULL, NO purchased Atlas listing within +/-10 min, and either the same seller
-- lists the NFT after sold_at (713) or a later sale (any source, > 2 min on) has the same seller (41).
-- Measured 754 rows, $48,611. Left: ~260 buyer-NULL rows with no Atlas events at all (unprovable) and every row with a buyer.
--
-- anon-exec: n/a (no function). Table RLS on, all grants revoked.
-- Revert: DROP TABLE public.audit_20261104_atlas_backfill_seller_relisted_sales;

CREATE TABLE public.audit_20261104_atlas_backfill_seller_relisted_sales AS
SELECT s.*
  FROM public.sales s
 WHERE s.source = 'atlas_backfill'
   AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND s.buyer_address IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events e
                    WHERE e.nft_id = s.nft_id AND e.product = 'nba' AND e.kind = 'listing' AND e.purchased
                      AND e.purchased_at BETWEEN s.sold_at - interval '10 minutes' AND s.sold_at + interval '10 minutes')
   AND (
     EXISTS (SELECT 1 FROM public.topshot_atlas_market_events e
              WHERE e.nft_id = s.nft_id AND e.product = 'nba' AND e.kind = 'listing'
                AND lower('0x' || e.seller_address) = lower(s.seller_address)
                AND e.listed_at > s.sold_at)
     OR EXISTS (SELECT 1 FROM public.sales o
                 WHERE o.collection_id = s.collection_id AND o.nft_id = s.nft_id
                   AND o.sold_at > s.sold_at + interval '2 minutes'
                   AND o.seller_address = s.seller_address)
   );

ALTER TABLE public.audit_20261104_atlas_backfill_seller_relisted_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261104_atlas_backfill_seller_relisted_sales FROM PUBLIC, anon, authenticated;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261104_atlas_backfill_seller_relisted_sales;
  IF n < 730 OR n > 780 THEN
    RAISE EXCEPTION 'expected ~754 seller-relisted sales, got %', n;
  END IF;
END $$;
