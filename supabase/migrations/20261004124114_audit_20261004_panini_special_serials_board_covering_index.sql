-- audit_20261004_panini_special_serials_board_covering_index
--
-- 2026-10-04 ~5:45 AM PT (Claude Code cloud). Companion to 20261004123243 (the deal board).
--
-- WHAT. With the deal board fixed, the 5:37 AM PT refresh-insights-cache tick still failed the
-- panini-boards snapshot on `panini_special_serials_board: canceling statement due to statement
-- timeout` (it had also failed at 5:22). Every board read must succeed for the snapshot to cache.
--
-- MEASURED (EXPLAIN ANALYZE, BUFFERS): the board read took 10.6 s. Nearly all of it was an Index Scan
-- on idx_panini_serials_special_true (a bare `(is_special) WHERE is_special` index) over ~37.8 k
-- special serials, reading 24,545 heap blocks from disk, the same random-heap-visit shape as the deal
-- board, on the same 2.4 GB table.
--
-- FIX. A covering partial index WHERE is_special, keyed on edition_external_id (text_pattern_ops,
-- so the view's `LIKE 'packcard-2332\_%'` becomes an index RANGE: 13 k rows scanned instead of 37.8 k),
-- INCLUDE-ing every serial column the board reads. Built CONCURRENTLY via execute_sql; valid, 5.9 MB.
-- IF NOT EXISTS makes this apply a no-op.
--
-- RESULT, same query, same 2,466 qualifying rows: Index Only Scan, 2,161 heap fetches (the old node
-- touched ~32.5 k blocks), 110 ms.
--
-- REVERT: DROP INDEX CONCURRENTLY IF EXISTS public.idx_panini_serials_special_cover;

CREATE INDEX IF NOT EXISTS idx_panini_serials_special_cover
  ON public.panini_card_serials USING btree (edition_external_id text_pattern_ops)
  INCLUDE (sku, serial_number, mint_cap, is_number_one, is_jersey_mint, is_perfect_mint, nft_type,
           price_usd, last_sale_usd, last_sale_at, captured_at)
  WHERE is_special;
