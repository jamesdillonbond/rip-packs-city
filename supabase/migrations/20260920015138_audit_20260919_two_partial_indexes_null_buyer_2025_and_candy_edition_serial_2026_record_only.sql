-- RECORD-ONLY, following the 20260919141500 (R108) precedent: CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block, so both indexes were built live as one-off single-statement pg_cron
-- jobs (postgres, no prefix, both unscheduled afterwards) and this body is the non-concurrent
-- form, a no-op against the existing indexes (matched by name) and correct for a fresh database.
--
-- Built 2026-09-19 6:43–6:49 PM PT on a quiet box (io_wait 0):
--
-- 1. idx_sales_2025_null_buyer_coll_sold — jobid 533, 8.9 s, 11 MB, indisvalid.
--    WHY: the daily `golazos-buyer-backfill` / `allday-buyer-backfill` candidate SELECT
--    (`collection = X AND (buyer_address IS NULL OR buyer_address IN (3 intermediaries)) AND
--    transaction_hash IS NOT NULL AND sold_at >= 2025-01-01 ORDER BY sold_at DESC LIMIT 120`)
--    had no usable index on sales_2025 and bitmap-scanned ALL 302,975 null-buyer rows across
--    every collection to find Golazos' ZERO: 21,474 buffers / 6.0 s healthy, 30 s kills under
--    any spell (0/1 ok on 09-18 and 09-19 → the Pipeline Success Coverage arm). After:
--    471 buffers / 143 ms (−98 %). Golazos has 0 null-buyer rows in 2025; All Day has 92,708.
--
-- 2. idx_sales_2026_candy_edition_serial_sold — jobid 537, 12.6 s, 376 kB, indisvalid.
--    WHY: `candy_special_serials_board` (a public /candy-mlb board; 5,193 ms on the 5:28 PM PT
--    liveness sweep, one of the two `public_board_slow_count` breaches) resolves each serial's
--    last sale through a LATERAL over sales, and the sales_2026 leg walked every sale of the
--    edition per serial via sales_2026_edition_id_sold_at_idx (30,627 of 42,070 buffers). After:
--    that leg is an Index Only Scan at 1,299 buffers; whole view 42,070 → 12,742 buffers (−70 %).
--    Partial on Candy's collection_id (7,433 rows) so the hot partition carries 376 kB, not 40 MB.
--    ⚠ The remaining ~9k buffers are the LATERAL probing sales_2020–2025 + 2027 for a collection
--    that only exists in 2026 — a VIEW change (add a sold_at bound), not an index; not done here
--    (the view is drift-pinned and CREATE OR REPLACE VIEW resets security_invoker).
--
-- ⛔ A THIRD index was built and DROPPED in the same pass, so nobody rebuilds it:
--    idx_sales_2026_null_buyer_coll_sold (jobid 536, 5.9 s; dropped jobid 538). The planner kept
--    the ordered idx_sales_2026_pulse_window scan for the All Day 2026 leg (it walks ~129k newer
--    non-null rows to find 120 nulls — 87k buffers) because the `OR buyer_address IN (…)` arm
--    defeats the partial index for ordering. "The right index is only half the fix" — verified
--    by EXPLAIN before and after, dropped rather than carried as write amplification.
--
-- Applied via the Supabase MCP; this file commits as usual.
-- REVERT: DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2025_null_buyer_coll_sold;
--         DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2026_candy_edition_serial_sold;

CREATE INDEX IF NOT EXISTS idx_sales_2025_null_buyer_coll_sold
  ON public.sales_2025 (collection, sold_at DESC)
  WHERE buyer_address IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_2026_candy_edition_serial_sold
  ON public.sales_2026 (edition_id, serial_number, sold_at DESC)
  WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_sales_2025_null_buyer_coll_sold' AND i.indisvalid) THEN RAISE EXCEPTION 'idx_sales_2025_null_buyer_coll_sold missing or invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_sales_2026_candy_edition_serial_sold' AND i.indisvalid) THEN RAISE EXCEPTION 'idx_sales_2026_candy_edition_serial_sold missing or invalid'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_sales_2026_null_buyer_coll_sold') THEN RAISE EXCEPTION 'the dropped 2026 null-buyer index is back'; END IF;
END $$;
