-- audit_20261004_panini_player_board_rookie_index
--
-- 2026-10-04 ~5:50 AM PT (Claude Code cloud). Third of the Panini-board fixes (20261004123243 deal
-- board, 20261004124114 special serials). The panini-boards snapshot caches only when EVERY board
-- read succeeds, so the player board was the last one that could still time it out.
--
-- MEASURED (EXPLAIN ANALYZE, BUFFERS): panini_player_board took 6.35 s cold. Its rookie_editions
-- column is a per-edition EXISTS (cs.edition_external_id = e.external_id AND cs.nft_type LIKE
-- '%rookie card%'). The only index the plan could use was idx_panini_serials_edition_agg, so for every
-- one of the 5,207 WC editions it walked ALL of that edition's serials looking for a rookie. A
-- non-rookie edition never short-circuits. That cost 19,160 heap fetches and 8,531 disk reads.
--
-- FIX. A partial index of rookie serials only (407 k of 1.46 M rows), keyed on edition_external_id.
-- The EXISTS becomes one index probe that is empty for a non-rookie edition. Built CONCURRENTLY via
-- execute_sql; valid, 3.1 MB. IF NOT EXISTS makes this apply a no-op.
--
-- RESULT, same query, same 200 rows: 0.68 s. The sub-plan is an Index Only Scan, 5 us/loop,
-- 16,384 buffer hits and 0 disk reads.
--
-- REVERT: DROP INDEX CONCURRENTLY IF EXISTS public.idx_panini_serials_rookie_edition;

CREATE INDEX IF NOT EXISTS idx_panini_serials_rookie_edition
  ON public.panini_card_serials USING btree (edition_external_id)
  WHERE (nft_type ~~ '%rookie card%'::text);
