-- sales-counterparty-backfill pipeline: claim_sales_counterparty_batch() was the
-- #1 disk-IOPS consumer in pg_stat_statements (186.8M shared_blks_read, mean ~39s,
-- routinely hitting the statement-timeout) — the single biggest driver of the
-- IOPS-contention family that makes other pipelines flap on this Micro instance.
--
-- The claim selects NULL-seller sales for 3 collections below a runtime cursor,
--   ... WHERE s.seller_address IS NULL AND s.collection IN (...)
--       AND (st.cursor_sold_at IS NULL OR s.sold_at < st.cursor_sold_at)
--   ORDER BY s.sold_at DESC LIMIT 120
-- Because the cursor is a runtime value (CROSS JOIN state table), NO partition
-- pruning happens and NO index provided sold_at order for null-seller rows, so
-- every call seq-scanned all 8 sales_YYYY partitions and sorted ~1M rows to take
-- 120. Measured before: ~39s / ~125k disk reads per call.
--
-- These partial indexes give each historical partition a sold_at-DESC stream of
-- null-seller rows. sales is range-partitioned by year, so the planner uses an
-- ORDERED APPEND (newest partition first) + per-partition index scans and stops
-- after the LIMIT is satisfied. Measured after: ~2.3-2.7s / ~6.4k disk reads
-- (~14-17x faster, ~19x fewer reads), and partitions below the satisfying one are
-- "never executed". EXPLAIN-verified + independent subagent PASS.
--
-- sales_2026 is deliberately NOT indexed here: it is the active-ingest partition
-- (adding an index there costs write-amplification on the hottest write path) and
-- it already has sales_2026_seller_address_idx which the plan uses cheaply for its
-- small above-cursor residual. sales_2027 is empty. As the cursor descends through
-- the past, 2020-2025 coverage is what this query needs.
--
-- Applied in prod as CREATE INDEX CONCURRENTLY via execute_sql, one partition at a
-- time with health checks between (no parallel build wave — per the 2026-07-14 IOPS
-- lesson); recorded here as plain CREATE INDEX IF NOT EXISTS for repo/history parity.
-- Revert: DROP INDEX IF EXISTS public.idx_sales_2020_nullseller_soldat,
--   public.idx_sales_2021_nullseller_soldat, public.idx_sales_2022_nullseller_soldat,
--   public.idx_sales_2023_nullseller_soldat, public.idx_sales_2024_nullseller_soldat,
--   public.idx_sales_2025_nullseller_soldat;
CREATE INDEX IF NOT EXISTS idx_sales_2020_nullseller_soldat ON public.sales_2020 (sold_at DESC) WHERE seller_address IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_2021_nullseller_soldat ON public.sales_2021 (sold_at DESC) WHERE seller_address IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_2022_nullseller_soldat ON public.sales_2022 (sold_at DESC) WHERE seller_address IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_2023_nullseller_soldat ON public.sales_2023 (sold_at DESC) WHERE seller_address IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_2024_nullseller_soldat ON public.sales_2024 (sold_at DESC) WHERE seller_address IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_2025_nullseller_soldat ON public.sales_2025 (sold_at DESC) WHERE seller_address IS NULL;
