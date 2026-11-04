-- 2026-11-04 (Claude Code cloud) — step 1 of 2: BACK UP the Top Shot "sales" that are cancelled listings.
--
-- backfill_topshot_sales_from_atlas_events() (20260909003000) recovered Top Shot sales from Atlas
-- marketplace events with `kind = 'listing' AND completed IS TRUE` — but Atlas marks a listing
-- `completed` when it ENDS, including when the seller cancels / reprices it. The purchase flag is
-- `purchased`, which the function never read (the live lane, sync_sales_from_atlas, does). And its
-- NOT EXISTS (same nft, same day) kept exactly the listing-ends that had no real sale behind them.
-- Found on /nba-top-shot/edition/241:8054 (Kon Knueppel Signature Series 1/1): three "sales"
-- 09-01 / 09-04 / 09-05 ($12,000 / $8,000 / $7,500), seller = the owner who still holds it, buyer
-- NULL — the owner repricing a listing ~60 times.
--
-- Measured 11-04 (all 6,589 atlas_backfill rows, sold 08-10 → 09-09): within ±2 min of the row,
--   matches a PURCHASED Atlas listing: 115 · matches only a CANCELLED (completed, not purchased) one: 4,364
-- Positive control, 400 random on-chain Top Shot sales in the same window: purchased 182 · cancelled 5.
-- This table holds the PROVEN class only: buyer NULL, a cancelled listing-end within ±2 min, and NO
-- purchased listing within ±2 min — 4,361 rows, 1,613 editions, $388,216. The ~2,113 rows that match
-- no Atlas event (1,035 NFTs have no events left at all) are NOT included: unprovable either way.
-- No FK or soft reference (sales_counterparty_recovered, topshot_insider_buybacks, unmapped_sales,
-- sales_ingest_unresolved / _recovered) names any of them.
--
-- Revert: DROP TABLE public.audit_20261104_atlas_backfill_cancelled_listing_sales;

CREATE TABLE public.audit_20261104_atlas_backfill_cancelled_listing_sales AS
SELECT s.*
  FROM public.sales s
 WHERE s.source = 'atlas_backfill'
   AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND s.buyer_address IS NULL
   AND EXISTS (SELECT 1 FROM public.topshot_atlas_market_events e
                WHERE e.nft_id = s.nft_id AND e.product = 'nba' AND e.kind = 'listing'
                  AND e.completed AND NOT e.purchased
                  AND e.purchased_at BETWEEN s.sold_at - interval '2 minutes' AND s.sold_at + interval '2 minutes')
   AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events e
                    WHERE e.nft_id = s.nft_id AND e.product = 'nba' AND e.kind = 'listing'
                      AND e.purchased
                      AND e.purchased_at BETWEEN s.sold_at - interval '2 minutes' AND s.sold_at + interval '2 minutes');

ALTER TABLE public.audit_20261104_atlas_backfill_cancelled_listing_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261104_atlas_backfill_cancelled_listing_sales FROM PUBLIC, anon, authenticated;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261104_atlas_backfill_cancelled_listing_sales;
  IF n < 4300 OR n > 4400 THEN
    RAISE EXCEPTION 'expected ~4,361 cancelled-listing sales, got %', n;
  END IF;
END $$;
