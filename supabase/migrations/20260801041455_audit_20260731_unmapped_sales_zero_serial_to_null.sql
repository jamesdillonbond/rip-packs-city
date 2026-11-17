-- Applied to prod 2026-07-31 PT via MCP (schema_migrations 20260801041455);
-- filed here for the on-disk revert path.
--
-- Make promote_unmapped_sales' map_serial fallback REACHABLE for the pending backlog.
--
-- promote_unmapped_sales inserts COALESCE(r.serial_number, r.map_serial, 0).
-- COALESCE returns the first NON-NULL value, so the literal 0 that all three
-- onchain indexers wrote to unmapped_sales.serial_number always won and
-- r.map_serial (nft_edition_map, then wallet_moments_cache) has been unreachable
-- dead code for the entire history of this table: 96,577 rows, ALL of them 0,
-- zero NULLs, zero positives.
--
-- The writer fix ships in the same wave (allday/golazos/ufc-sales-indexer now
-- write NULL). This drains the pending STOCK so the 38,491 rows that have a
-- serial on file (AllDay 19,168 map + 983 wmc; TopShot 18,340) promote into
-- public.sales with the real serial instead of NULL.
--
-- Lossless: 0 is not a real Flow serial (they start at 1), it is a non-value, so
-- nothing is destroyed. No consumer depends on the 0 -- unmapped_sales.serial_number
-- has zero code readers, and the only DB reader referencing a literal 0
-- (analytics_data_quality_overview) is NULL-aware AND reads public.sales, not this
-- table. Column is nullable with no default.
--
-- Verified after apply: 96,577 rows, 96,577 NULL, 0 zero, 0 positive.
--
-- Revert (exact, since every row was 0 before):
--   UPDATE public.unmapped_sales SET serial_number = 0 WHERE serial_number IS NULL;
UPDATE public.unmapped_sales
   SET serial_number = NULL
 WHERE serial_number = 0;
