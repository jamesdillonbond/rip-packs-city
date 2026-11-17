-- audit_20261025_pack_purchases_dist_covering_index
--
-- 2026-10-25 (Claude Code cloud; Trevor: "work on roadmap and known issues … Keep going").
--
-- WHY. Vercel carries `[pack-detail/pack_lifecycle] read exceeded 5000ms` (4 users in 7 d, newest 10-25
-- 10:16 AM PT) — the pack page's lifecycle row. pgss for get_pack_lifecycle_row: 81,849 calls, mean 896 ms,
-- stddev 3,105 ms, max 29,949 ms. The body (20261002, "two steps, one predicate") reads, per dist, every
-- pack_purchases row's pack_nft_id via idx_pack_purchases_pack_dist_id (pack_dist_id, sealed_at) and then
-- the HEAP: for dist 8433 (17,660 purchases) a Bitmap Heap Scan over 4,564 scattered heap blocks — 4,618
-- buffers, 2,059 read from disk, i.e. 2,059 of the plan's 2,134 cold reads. That leg is the cold tail.
--
-- HOW. (pack_dist_id, collection_id) INCLUDE (pack_nft_id), same partial predicate as the existing dist
-- index. pack_purchases is ~93 % all-visible (autovacuumed 10-22), so the read becomes an Index Only Scan.
-- Measured right after the build: dist 8512 that leg 910 buffers / 0 reads / 7.8 ms (was a bitmap heap scan
-- of ~4.6k blocks); whole function on dist 8433 10,775 -> 8,418 buffers, 53 ms warm. 22 MB. No HOT cost
-- that is not already paid: all three columns are already indexed.
--
-- NOT CHANGED: get_pack_lifecycle_row itself, idx_pack_purchases_pack_dist_id (other readers order by
-- sealed_at).
--
-- Built first with CREATE INDEX CONCURRENTLY via execute_sql (10-25 ~10:45 AM PT, indisvalid); this
-- statement is a no-op there and builds it on a fresh database (replay-safe).
-- REVERT: DROP INDEX public.idx_pack_purchases_dist_coll_nft;
SET lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS idx_pack_purchases_dist_coll_nft
  ON public.pack_purchases (pack_dist_id, collection_id)
  INCLUDE (pack_nft_id)
  WHERE (pack_dist_id IS NOT NULL);
