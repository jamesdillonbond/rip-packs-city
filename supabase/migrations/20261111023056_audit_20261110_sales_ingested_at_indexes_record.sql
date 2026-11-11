-- audit_20261110: RECORD-ONLY for sales_2026 (built with CREATE INDEX CONCURRENTLY from one-off pg_cron job
-- zz-cic-sales-2026-ingested-at, jobid 864, 2026-11-10 ~6:30 PM PT, unscheduled after it started); sales_2027 is
-- EMPTY, so its index is built here in-transaction (instant). In prod this file asserts both indexes are valid.
--
-- Why: the Sentinel's "Sales Ingest (2h)" check (app/api/sentinel/route.ts, .github/workflows/pipeline-sentinel.yml)
-- counts `sales` WHERE ingested_at >= now()-2h AND sold_at >= Jan 1 through PostgREST head:true. No sales partition
-- had an index on ingested_at, so every tick was a parallel seq scan of all of sales_2026: measured 52,328 blocks /
-- 3.5 s cold for 240 matching rows (pgss: ~100k blocks / 2.7-4.7 s per call across two statement ids, ~1,870 calls).
-- ingested_at's physical correlation is 0.67 (updates relocate tuples), too loose for a tight BRIN, so btree.
-- ingested_at is never updated, so this index does not cost HOT updates. Older partitions sit below the check's
-- sold_at floor (Jan 1 of now-45d) and are left alone.
--
-- Revert: DROP INDEX CONCURRENTLY public.idx_sales_2026_ingested_at; DROP INDEX public.idx_sales_2027_ingested_at;

CREATE INDEX IF NOT EXISTS idx_sales_2026_ingested_at ON public.sales_2026 USING btree (ingested_at);
CREATE INDEX IF NOT EXISTS idx_sales_2027_ingested_at ON public.sales_2027 USING btree (ingested_at);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_sales_2026_ingested_at','idx_sales_2027_ingested_at')
     AND i.indisvalid AND i.indisready;
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 valid sales ingested_at indexes, found %', n;
  END IF;
END $$;
