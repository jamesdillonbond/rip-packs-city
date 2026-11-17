-- audit_20260909: known-issue #68's DURABLE GUARD — a per-partition unique index on
-- (transaction_hash, nft_id, price_usd). Closes the hole that let 33,000 duplicate Top Shot sales in.
--
-- ⚠ THESE INDEXES ALREADY EXIST IN PROD. They were built 2026-09-09 00:2xZ with
-- `CREATE UNIQUE INDEX CONCURRENTLY` (which cannot run inside a migration's transaction), so the
-- statements below are `IF NOT EXISTS` no-ops whose purpose is to RECORD the change in
-- `supabase_migrations.schema_migrations` and carry its reasoning. ⚠ On a from-scratch replay they would
-- build NON-concurrently and take a write lock on the partition — for a rebuild that is fine; to
-- reproduce the live build, run them CONCURRENTLY outside a transaction instead.
--
-- ⛔⛔ WHY THE FIX EVERY EARLIER NOTE RECOMMENDED IS IMPOSSIBLE, NOT MERELY UNWISE.
-- The #68 filing and two ledger entries said: re-cut `idx_sales_tx_nft_sold` without `sold_at`, i.e.
-- `UNIQUE (transaction_hash, nft_id)` on `public.sales`. **`public.sales` is RANGE-partitioned on
-- `sold_at`** (8 partitions, `sales_2020`…`sales_2027`), and PostgreSQL requires a unique index on a
-- partitioned parent to CONTAIN THE PARTITION KEY. So that index cannot be created at the parent at all
-- — and the `sold_at` in the existing index, which is exactly what let the duplicates through, was never
-- a careless choice: **it was forced by the partitioning.** No parent-level unique index can ever dedupe
-- this class. (A second, independent reason it was wrong: it would also have refused 1,607 legitimate
-- rows, because the 2020 historical import reuses one placeholder `transaction_hash` across genuinely
-- different sales — 1,521 groups, all at different prices, 1,509 spanning >10 min, the widest 100 days.)
--
-- ✅ WHAT WORKS, AND WHY IT IS COMPLETE. Index the PARTITIONS directly rather than the parent. A
-- per-partition unique index enforces uniqueness within its own partition, and **the duplicate class is
-- always same-partition by construction**: the two writers record the same transaction seconds apart
-- (median 3.4 s), so both rows always fall in the same year. `price_usd` in the key is what makes it
-- tolerate the 2020 import (those groups differ in price) while still catching #68 exactly — it is the
-- key tonight's drain deduped on. Verified 0 violations on EVERY partition 2020→2026 before building.
--
-- SCOPE: built on `sales_2026` (the live partition, 1,049,564 rows → a 105 MB index) and `sales_2027`
-- (empty, so the protection is already in place when the year rolls over). The closed historical
-- partitions are deliberately left alone: nothing writes to them, and 2020 could not take this index
-- anyway without first resolving its placeholder-hash rows.
--
-- BEHAVIOUR ON A DUPLICATE, checked in the code before shipping: every `sales` writer inserts with a bare
-- `.insert()`; `app/api/sales-indexer/route.ts` batches, and on error falls back to `insertIndividually()`
-- where a per-row failure increments `duped` and continues — it **already treats `23505` as an expected
-- outcome and does not even log it**. That route was written expecting a unique index to catch duplicates;
-- it simply never could. `promote_unmapped_sales` uses a bare `ON CONFLICT DO NOTHING`, which now also
-- covers this constraint. `sync_sales_from_atlas` writes `transaction_hash IS NULL` rows, which the
-- partial predicate exempts entirely.
--
-- POSITIVE CONTROL (a constraint that has never rejected anything is not a proven constraint), run
-- 2026-09-09 00:2xZ and rolled back with no residue: inserting a copy of a real 2026 sale with the SAME
-- transaction_hash + nft_id + price_usd and `sold_at + 3 seconds` — precisely the shape the old index
-- permitted for six weeks — raised `unique_violation`. Result recorded: blocked = TRUE, 0 probe rows left.
--
-- REVERT (a stranger can run this):
--   DROP INDEX CONCURRENTLY public.sales_2026_tx_nft_price_uidx;
--   DROP INDEX CONCURRENTLY public.sales_2027_tx_nft_price_uidx;
-- The detector (jobid 480 `rpc-topshot-dupe-sales-watch`) is independent and keeps working either way.

CREATE UNIQUE INDEX IF NOT EXISTS sales_2026_tx_nft_price_uidx
  ON public.sales_2026 (transaction_hash, nft_id, price_usd)
  WHERE transaction_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sales_2027_tx_nft_price_uidx
  ON public.sales_2027 (transaction_hash, nft_id, price_usd)
  WHERE transaction_hash IS NOT NULL;