-- The old unique index (transaction_hash, sold_at) made a multi-item transaction
-- unstorable: every item of one purchase shares a tx hash and a block timestamp,
-- so public.sales could hold exactly ONE row per transaction. Widening to include
-- nft_id admits N items per transaction while keeping the indexer's idempotency
-- (same tx + same nft = same sale) intact.
--
-- NULLS NOT DISTINCT preserves the OLD strictness for the 15,951 legacy rows with
-- a NULL nft_id (a 2026-03-23..30 backfill artifact; no live writer produces them).
-- Without it btree would treat those NULLs as distinct and stop deduping them.
--
-- Partition-local children were built CONCURRENTLY beforehand and are attached here.

CREATE UNIQUE INDEX idx_sales_tx_nft_sold ON ONLY public.sales
  USING btree (transaction_hash, nft_id, sold_at) NULLS NOT DISTINCT
  WHERE (transaction_hash IS NOT NULL);

ALTER INDEX public.idx_sales_tx_nft_sold ATTACH PARTITION public.sales_2020_tx_nft_sold_idx;
ALTER INDEX public.idx_sales_tx_nft_sold ATTACH PARTITION public.sales_2021_tx_nft_sold_idx;
ALTER INDEX public.idx_sales_tx_nft_sold ATTACH PARTITION public.sales_2022_tx_nft_sold_idx;
ALTER INDEX public.idx_sales_tx_nft_sold ATTACH PARTITION public.sales_2023_tx_nft_sold_idx;
ALTER INDEX public.idx_sales_tx_nft_sold ATTACH PARTITION public.sales_2024_tx_nft_sold_idx;
ALTER INDEX public.idx_sales_tx_nft_sold ATTACH PARTITION public.sales_2025_tx_nft_sold_idx;
ALTER INDEX public.idx_sales_tx_nft_sold ATTACH PARTITION public.sales_2026_tx_nft_sold_idx;
ALTER INDEX public.idx_sales_tx_nft_sold ATTACH PARTITION public.sales_2027_tx_nft_sold_idx;

-- Drop the narrow parent (cascades to its attached partition indexes).
DROP INDEX public.idx_sales_tx_hash;

-- The SECOND blocker, missed by the 2026-07-31 handoff: a standalone,
-- partition-local unique index on (transaction_hash) ALONE with no parent.
-- It is even narrower than the parent -- one row per tx regardless of sold_at --
-- and sales_2026 is the live partition, so leaving it would have made the whole
-- migration a no-op for current-year sales.
DROP INDEX public.sales_2026_transaction_hash_unique_idx;

COMMENT ON INDEX public.idx_sales_tx_nft_sold IS
  'Idempotency key for every sales writer: one row per (transaction_hash, nft_id) '
  'per sale timestamp. Deliberately admits multiple items from a single '
  'transaction -- the predecessor idx_sales_tx_hash (transaction_hash, sold_at) '
  'could not, silently dropping every item but the first of a bulk purchase. '
  'sold_at is required because sales is RANGE-partitioned on it. '
  'See docs/overnight/ledger.md 2026-07-31.';