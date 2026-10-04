-- audit_20261004_panini_deal_board_covering_index
--
-- 2026-10-04 ~5:40 AM PT (Claude Code cloud).
--
-- WHAT PAGED. refresh-insights-cache logged `panini-boards: panini_deal_board: canceling statement
-- due to statement timeout` (5:22 AM PT; the same cluster the overnight pass saw 9:22–11:22 PM PT and
-- called a transient). The panini-boards snapshot stopped rebuilding and `public_board_slow_count`
-- breached.
--
-- MEASURED (EXPLAIN ANALYZE, BUFFERS; no IO spell: 0 IO waits at the time). The board read took
-- 23.8 s. 22.6 s of it was one node: an Index Scan on idx_panini_serials_listed_edition reading
-- 95,988 listed serials with 38,245 HEAP blocks from disk. The index carried only (price_usd,
-- captured_at), and the view needs ~10 more serial columns, so every listed row cost a random heap
-- visit into a table that is now 1.44 M rows / 2.4 GB (it was ~3 s / 86 k buffers on 2026-09-25).
-- Structural, not a spell: it grows with the table.
--
-- FIX. A covering partial index on the same predicate (is_listed AND price_usd > 0), carrying every
-- serial column the board reads, so the scan is index-only (relallvisible 224,241 / 240,904).
-- Built CONCURRENTLY via execute_sql (sized first: one heap pass = 15.4 s; build fit the 60 s cap),
-- valid, 13 MB. This file records it; IF NOT EXISTS makes the apply a no-op.
--
-- RESULT, same query, same rows (264 qualifying, top 200 returned): 23.8 s -> 0.99 s; disk reads
-- 39,643 -> 3,111 blocks; Index Only Scan, 7,143 heap fetches.
--
-- The old idx_panini_serials_listed_edition is NOT dropped here: other readers may use it, and a
-- drop is a separate, measured decision.
--
-- REVERT: DROP INDEX CONCURRENTLY IF EXISTS public.idx_panini_serials_listed_edition_cover;

CREATE INDEX IF NOT EXISTS idx_panini_serials_listed_edition_cover
  ON public.panini_card_serials USING btree (edition_external_id)
  INCLUDE (price_usd, captured_at, sku, serial_number, mint_cap, best_offer_usd, last_sale_usd,
           is_jersey_mint, is_perfect_mint, is_number_one)
  WHERE (is_listed AND (price_usd > (0)::numeric));
