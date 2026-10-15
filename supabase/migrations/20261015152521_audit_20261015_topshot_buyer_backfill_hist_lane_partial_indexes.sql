-- 2026-10-15 (Claude Code cloud, ~8:35 AM PT). RECORD-ONLY (precedent 20260919141500): the three
-- indexes below were built live with CREATE INDEX CONCURRENTLY via execute_sql (each well inside
-- the 60 s client window; all indisvalid = true). The statements are no-ops against them and the
-- correct non-concurrent form for a fresh database.
--
-- CAUSE: /api/admin/backfill-topshot-buyers' historical lane (window 2023-11-08 -> 2025-01-01) runs
-- ~44x/day and its window is DRAINED (0 rows with buyer, payer both NULL). Yet each run:
--   (a) the batch read seq-scanned ALL of sales_2023 (39,316 blocks ~ 307 MB, 1.27M rows filtered)
--       because only sales_2024 carried the TS null-buyer partial index;
--   (b) the `exhausted_in_window` count (buyer NULL, payer NOT NULL) walked sales_2024's and
--       sales_2023's payer_address indexes (36,278 blocks): the planner estimates the null-buyer
--       index at ~125k rows when it holds ~45 (correlated predicates; stats were fresh), so it
--       never chose it.
-- pg_stat_statements (cumulative since 08-11): the two statements = 75.8M + 56.7M blocks read.
--
-- MEASURED (EXPLAIN ANALYZE BUFFERS, same predicates as the route):
--   batch read  39,335 blocks / 1,522 ms -> 57 blocks / 0.3 ms
--   count        36,278 blocks / 1,130 ms -> 10 blocks / 0.2 ms (same answer, 45)
-- Sizes: 11 MB, 136 kB, 16 kB.
--
-- REVERT (each from a one-statement pg_cron job or the SQL editor, one statement each):
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2023_ts_nullbuyer;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2023_ts_decoded_nobuyer;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2024_ts_decoded_nobuyer;

SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_sales_2023_ts_nullbuyer ON public.sales_2023 USING btree (sold_at DESC)
  WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL) AND (collection = 'nba_top_shot'::text));

CREATE INDEX IF NOT EXISTS idx_sales_2023_ts_decoded_nobuyer ON public.sales_2023 USING btree (sold_at DESC)
  WHERE ((buyer_address IS NULL) AND (payer_address IS NOT NULL) AND (transaction_hash IS NOT NULL) AND (collection = 'nba_top_shot'::text));

CREATE INDEX IF NOT EXISTS idx_sales_2024_ts_decoded_nobuyer ON public.sales_2024 USING btree (sold_at DESC)
  WHERE ((buyer_address IS NULL) AND (payer_address IS NOT NULL) AND (transaction_hash IS NOT NULL) AND (collection = 'nba_top_shot'::text));
