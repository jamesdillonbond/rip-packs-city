-- audit_20260831: get_serial_backfill_targets seq-scans every partition of
-- public.sales because the 2026-07-05 correctness repoint orphaned BOTH of the
-- partial indexes that used to serve it.
--
-- HISTORY. `audit_20260705_serial_recovery_null_sentinel` widened the recovery
-- predicate from `serial_number = 0` to `(serial_number IS NULL OR
-- serial_number = 0)` -- correct, and it kept the drain honest. But the two
-- partial indexes on each sales partition are shaped for the two halves
-- SEPARATELY: `idx_sales_<yr>_null_serial` is `(sold_at) WHERE serial_number
-- IS NULL AND nft_id IS NOT NULL`, and `sales_<yr>_collection_id_idx` is
-- `(collection_id) WHERE serial_number = 0`. Neither predicate is implied by
-- the OR, so from 07-05 the planner has had no usable index and has read the
-- whole heap of all eight partitions on every call. Nobody noticed because the
-- repoint was measured on ROWS RETURNED, not on buffers.
--
-- MEASURED 2026-08-31 09:0xZ, EXPLAIN (ANALYZE, BUFFERS) THROUGH THE FUNCTION
-- (not the body with literals -- item 13's rule):
--   get_serial_backfill_targets(NULL, 500, 0)
--     -> shared hit=12,237 read=109,371  (854 MB)  6,656 ms  for rows=1.
-- Only 1,929 rows in the whole table satisfy the predicate (1,917 of them Top
-- Shot + All Day), against 1.29 GB of heap across sales_2020..sales_2027 --
-- so this is a ~150 KB index standing in for a full-heap scan.
--
-- COST IN CONTEXT. `sales-serial-backfill` runs 2-hourly. pg_stat_statements
-- diffed against `audit_20260830_pgss_snap` 05:06:44Z on
-- (userid, dbid, toplevel, queryid): 4 calls, 412,490 blocks read, 103,123
-- blocks/call -- the highest per-call disk reader on the board in that window
-- and #6 by total. The last six runs wrote 0/1/2/4/3/0 rows: ~10 sales
-- resolved in 12 h for ~19 GB/day of reads.
--
-- ⚠ NOT FIXED HERE, AND DELIBERATELY: the run at 09:0xZ found ONE actionable
-- row against 1,917 qualifying, because the `sales_serial_backfill_failures`
-- 24 h cooldown holds the rest. Those rows re-enter every 24 h, fail again and
-- go back on cooldown -- a retry treadmill over a set the ledger already
-- recorded as unrecoverable from this path (2026-07-05: "9,675 AllDay NOT
-- recoverable ... needs the deployed sales-serial-backfill edge fn triggered
-- with a real INGEST_SECRET_TOKEN -- operator/CC action"). This index makes
-- the treadmill cheap; it does not stop it. Stopping it is an operator call.
--
-- WHAT WAS DONE LIVE (this file records it; on prod every statement below is a
-- no-op): eight per-partition indexes were built CONCURRENTLY 2026-08-31
-- 09:16-09:30Z by one-off postgres-owned pg_cron jobs (jobids 417-424,
-- unscheduled after; `tmp-idxbuild-sales-<yr>-serial-targets`). No
-- statement_timeout window was opened -- every partition built inside the
-- 120 s cluster default. cron_heavy cannot create indexes (CREATE INDEX needs
-- the table owner), which is why these ran as postgres.
-- ⚠ No index is attached to the partitioned parent on purpose: a query against
-- `public.sales` expands to the partitions and uses each child's own indexes,
-- so ATTACHing would buy nothing and would take ACCESS EXCLUSIVE on the parent.
--
-- On a fresh database this file builds the indexes plainly.
-- anon-exec: none (no function created or replaced).
--
-- VERIFIED LIVE 09:31Z, same EXPLAIN through the same function, same params:
--   cold-ish : hit=9,149  read=1,191   694 ms
--   warm     : hit=10,340 read=0        21.3 ms
-- vs 09:0xZ  : hit=12,237 read=109,371 6,656 ms.
-- ⚠ The A/B that matters is TOTAL BUFFERS TOUCHED -- 121,608 -> 10,340, an
-- 11.8x drop -- because that is a plan change and cannot be a cache effect;
-- the 313x wall-clock figure is warm-vs-cold and is NOT the claim.
-- All eight built valid (jobids 417-424, 8/8 succeeded, 8.7-11.4 s each, one
-- 0.0 s no-op where an earlier interrupted attempt had already completed);
-- zero invalid indexes on any sales partition; zero tmp-idx% jobs left.
-- Total size of all eight: 120 KB.
--
-- Exit (24 h): get_serial_backfill_targets falls from ~103,000 blocks/call
-- toward < 1,000, and its mean from ~6 s toward < 100 ms, in a pgss diff
-- against a fresh audit_20260830_pgss_snap row.
-- Falsifier: blocks/call unchanged -> the planner is not matching the OR
-- predicate to the index (check with EXPLAIN THROUGH THE FUNCTION), and the
-- fix is instead to split the function into two UNION ALL branches that each
-- match one of the pre-existing partials.
-- Revert: DROP INDEX CONCURRENTLY public.idx_sales_2020_serial_backfill_targets;
--         ... and the same for 2021, 2022, 2023, 2024, 2025, 2026, 2027.

CREATE INDEX IF NOT EXISTS idx_sales_2020_serial_backfill_targets
  ON public.sales_2020 USING btree (sold_at)
  WHERE ((serial_number IS NULL OR serial_number = 0) AND nft_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sales_2021_serial_backfill_targets
  ON public.sales_2021 USING btree (sold_at)
  WHERE ((serial_number IS NULL OR serial_number = 0) AND nft_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sales_2022_serial_backfill_targets
  ON public.sales_2022 USING btree (sold_at)
  WHERE ((serial_number IS NULL OR serial_number = 0) AND nft_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sales_2023_serial_backfill_targets
  ON public.sales_2023 USING btree (sold_at)
  WHERE ((serial_number IS NULL OR serial_number = 0) AND nft_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sales_2024_serial_backfill_targets
  ON public.sales_2024 USING btree (sold_at)
  WHERE ((serial_number IS NULL OR serial_number = 0) AND nft_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sales_2025_serial_backfill_targets
  ON public.sales_2025 USING btree (sold_at)
  WHERE ((serial_number IS NULL OR serial_number = 0) AND nft_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sales_2026_serial_backfill_targets
  ON public.sales_2026 USING btree (sold_at)
  WHERE ((serial_number IS NULL OR serial_number = 0) AND nft_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sales_2027_serial_backfill_targets
  ON public.sales_2027 USING btree (sold_at)
  WHERE ((serial_number IS NULL OR serial_number = 0) AND nft_id IS NOT NULL);
