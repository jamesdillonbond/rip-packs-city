-- 2026-10-02 (PT) — an expression index for the #142 serial ceiling.
--
-- WHY. get_edition_recent_sales / get_edition_sale_history refuse a sale whose
-- serial exceeds the (set, play)'s base + parallels total (20260926042518).
-- That total is `sum(circulation_count) FROM editions WHERE collection_id = $1
-- AND circulation_count > 0 AND split_part(external_id, '::', 1) = $base`.
-- Its comment says a normal page load never pays for it; on the busiest Top
-- Shot edition (258:9304, 2026-10-02 ~8:40 PM PT) it RAN, as a bitmap scan of
-- all 14,485 Top Shot editions: 3,806 of ~4,000 execution buffers. The edition
-- page calls get_edition_recent_sales on every render (810,101 calls since
-- 2026-08-12).
--
-- WHAT. (collection_id, split_part(external_id::text, '::', 1)) INCLUDE
-- (circulation_count). editions is 31 MB / 33,913 rows, so a plain build (no
-- CONCURRENTLY) holds its write lock for well under a second. Measured right
-- after: the subquery 3,806 -> 5 buffers (Index Scan on this index); one
-- function call 9,255 -> 5,534 buffers, 66 -> 21 ms (first call in a session,
-- planning included).
--
-- Revert: DROP INDEX IF EXISTS public.idx_editions_collection_base_external_id;

CREATE INDEX IF NOT EXISTS idx_editions_collection_base_external_id
  ON public.editions (collection_id, (split_part(external_id::text, '::', 1)))
  INCLUDE (circulation_count);
