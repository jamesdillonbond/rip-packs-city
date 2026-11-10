-- audit_20261110: RECORD-ONLY. Three partial indexes built with CREATE INDEX CONCURRENTLY from one-off pg_cron jobs
-- (zz-cic-sales-202{3,4,6}-nullbuyer-coll, jobids 859-861, 2026-11-10 1:24:00 -> ~1:24:30 PM PT, 42 MB / 8.7 MB / 264 kB;
-- unscheduled while running, which marks the run_details row 'job canceled' but does NOT stop the backend: all
-- three finished indisvalid; 0 zz-* jobs left). In prod this file is
-- a no-op that asserts each index is valid.
--
-- Why (2-h pgss delta 10:05 AM -> 12:05 PM PT): /api/admin/backfill-topshot-buyers' head:true count probes over
-- `sales` cost 176k blocks / 23 s (below-floor band) and 54k blocks (forward window) PER CALL. Through PostgREST the
-- `collection = 'nba_top_shot'` filter arrives as a PARAMETER, and once the statement goes to a GENERIC plan the
-- planner cannot prove the existing `... AND collection = 'nba_top_shot'` partial indexes (idx_sales_202x_ts_nullbuyer)
-- apply, so sales_2023 fell back to a full scan of its (collection_id, sold_at) index with every predicate as a
-- Filter, and sales_2024 to a BitmapAnd of buyer_address IS NULL x the date range. With literals the same count is
-- 98 blocks. Measured after the build under force_generic_plan: the below-floor count is 102 blocks / 8 ms. sales_2025 already carried the generic-safe shape (idx_sales_2025_null_buyer_coll_sold, collection as a
-- KEY column, only IS NULL in the predicate) and was index-scanned under the generic plan; these three give the other
-- populated partitions the same shape. `transaction_hash IS NOT NULL` is in every caller's filter (it is the decode
-- key), so it narrows the predicate without losing a caller. sales_2027 is EMPTY, so this migration builds its
-- index in-transaction (instant) rather than leaving 2027-01-01 to rediscover the problem. 2020-2022 sit below every
-- caller's floor (2023-11-08) and are left alone.
--
-- Revert: DROP INDEX CONCURRENTLY public.idx_sales_2023_null_buyer_coll_sold;  (and _2024_, _2026_, _2027_; from a one-off
-- pg_cron job or the SQL editor)

CREATE INDEX IF NOT EXISTS idx_sales_2023_null_buyer_coll_sold ON public.sales_2023 USING btree (collection, sold_at DESC) WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_sales_2024_null_buyer_coll_sold ON public.sales_2024 USING btree (collection, sold_at DESC) WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_sales_2026_null_buyer_coll_sold ON public.sales_2026 USING btree (collection, sold_at DESC) WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_sales_2027_null_buyer_coll_sold ON public.sales_2027 USING btree (collection, sold_at DESC) WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL));
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_sales_2023_null_buyer_coll_sold','idx_sales_2024_null_buyer_coll_sold','idx_sales_2026_null_buyer_coll_sold','idx_sales_2027_null_buyer_coll_sold')
     AND i.indisvalid AND i.indisready;
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 valid sales null-buyer generic-plan indexes, found %', n;
  END IF;
END $$;
