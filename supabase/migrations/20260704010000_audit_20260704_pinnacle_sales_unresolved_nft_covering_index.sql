-- Issue 1 (pinnacle-nft-resolver 30s hard timeout, same class as Bugs 3/4/6):
-- pinnacle_get_unresolved_batch_v2's sales_targets leg heap-filtered
-- edition_id IS NULL over the full idx_pinnacle_sales_nft_id index (~8.3k buffer
-- hits, 9k rows removed by filter), degrading past service_role's 30s
-- statement_timeout as resolved rows accumulate — every failure logged
-- elapsed_ms ~30,000 with "load batch v2: canceling statement due to statement
-- timeout".
--
-- This partial covering index holds ONLY the ~7.5k unresolved rows, in
-- (nft_id, sold_at DESC) order with buyer_address as an INCLUDE payload, so the
-- DISTINCT ON (nft_id) ORDER BY nft_id, sold_at DESC scan becomes a sub-ms
-- index-only scan whose cost is bounded by the unresolved backlog, not total
-- table size (170k+ rows and growing).
--
-- Applied in prod as CREATE INDEX CONCURRENTLY via execute_sql (CONCURRENTLY
-- cannot run inside apply_migration's transaction); recorded here as plain
-- CREATE INDEX IF NOT EXISTS for repo/history parity.
-- Revert: DROP INDEX IF EXISTS public.idx_pinnacle_sales_unresolved_nft;
CREATE INDEX IF NOT EXISTS idx_pinnacle_sales_unresolved_nft
  ON public.pinnacle_sales (nft_id, sold_at DESC) INCLUDE (buyer_address)
  WHERE edition_id IS NULL;
