-- 2026-10-15 (Claude Code cloud). An index for "the last sale of THIS serial of THIS edition".
--
-- WHY. get_edition_special_serials (every edition page: #1 / jersey / last-mint rows) looks up each notable
-- serial's last sale with `WHERE edition_id = $1 AND serial_number = $n AND price_usd > 0 ORDER BY sold_at
-- DESC LIMIT 1`. No index carried serial_number for that shape (the serial indexes are serial-1-only or
-- Top-Shot-with-nft_id partials), so each lookup walked the edition's whole sale history across the year
-- partitions by sold_at and filtered serial afterwards — to the end of history for a serial that never sold.
-- pg_stat_statements 10-15: 563,942 calls, 109 ms avg, and the largest DISK reader in a 40-min window
-- (165,714 blocks read over 1,704 calls); it is also the "[entity-section] edition special serials ...
-- statement timeout — degrading to empty" runtime error.
--
-- HOW. Each partition's index was built first with CREATE INDEX CONCURRENTLY (execute_sql, one statement
-- each, 10-15 ~3:45-3:55 PM PT; all indisvalid; 356 MB total: 2020 3.8 MB · 2021 8.1 · 2022 36 · 2023 60 ·
-- 2024 70 · 2025 113 · 2026 65 · 2027 empty). This statement, on the PARENT, finds a matching index on every
-- partition and ATTACHES it instead of building — so it is metadata-only here, and on a fresh database it
-- builds the partitions itself (replay-safe). New partitions inherit it.
-- REVERT: DROP INDEX public.idx_sales_edition_serial_sold;  (drops the attached partition indexes with it)
SET lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS idx_sales_edition_serial_sold
  ON public.sales (edition_id, serial_number, sold_at DESC)
  WHERE price_usd > 0;
