-- audit_20261004_pack_rips_dist_agg_index_covers_pack_nft_id
--
-- 2026-10-04 ~7:50–8:15 AM PT (Claude Code, Trevor's box). The chronic
-- `[pack-detail] pack_lifecycle … read exceeded 5000ms` error on /[collection]/pack/dist/[distId]
-- (13 in the 24 h to 7:27 AM PT 10-04; 10 of them dist 5048, the smoke fixture, at cache=BYPASS
-- once per deploy, plus real MISS visits on 8548 / 1561 / 7160) and its All Day twin
-- `allday_pack_lifecycle`.
--
-- MEASURED. get_pack_lifecycle_row is fast warm (dist 5048: 17 ms, 3,525 buffers, all hits) and
-- slow cold: the production EXPLAIN runs recorded in pg_stat_statements took 6.0 s mean / 11.8 s
-- max with 5,455 blocks READ per call. The 09-03 header in lib/pack-dist/fetchers.ts called these
-- overruns instance contention; that was measured warm on the old Small tier. The cold cost is the
-- `cand` step (20261002154837): it walks the dist's rips on idx_pack_rips_dist_agg_v2 for the
-- hash anti-join on pack_nft_id, and v2 did not carry pack_nft_id, so every rip was a heap fetch
-- (dist 5048: 2,702 buffers for 3,159 rows). A rarely-visited dist is never in cache, so those are
-- random disk reads and the 5 s budget dies. v_allday_pack_lifecycle has the same shape on
-- sealed_at (dist 5594: Index Scan, 5,584 buffers, 4,442 read, 1.4 s cold).
--
-- FIX. Same key, same predicate, two more INCLUDE columns (pack_nft_id, sealed_at), so both
-- readers become Index Only Scans. Strict superset of v2. Built CONCURRENTLY via execute_sql,
-- valid, 275 MB (v2 was 249 MB). An intermediate v3 (pack_nft_id only, 243 MB) was built first,
-- then replaced when the All Day view turned out to need sealed_at; both v2 and v3 were dropped
-- CONCURRENTLY after the planner chose the replacement. IF NOT EXISTS / IF EXISTS make this apply
-- a no-op on production.
--
-- RESULT (buffers touched, same instrument before/after; results unchanged, an index cannot move
-- them):
--   get_pack_lifecycle_row rips walk, dist 5048:  2,702 -> 724, index-only
--   get_pack_lifecycle_row whole, dist 8552:     29,207 (10-02) -> 15,105
--   v_allday_pack_lifecycle, dist 5594:           5,584 -> 1,230, index-only
--   v_allday_pack_lifecycle, dist 5974:           1,368 disk reads / 5.6 s (09-xx) -> 849 / 10 ms
--
-- REVERT (v2 is a subset, so recreating it restores the old plans exactly):
--   CREATE INDEX CONCURRENTLY idx_pack_rips_dist_agg_v2 ON public.pack_rips (collection_id, dist_id)
--     INCLUDE (pull_value_usd, moments_pulled) WHERE dist_id IS NOT NULL;
--   DROP INDEX CONCURRENTLY idx_pack_rips_dist_agg_v4;

CREATE INDEX IF NOT EXISTS idx_pack_rips_dist_agg_v4
  ON public.pack_rips USING btree (collection_id, dist_id)
  INCLUDE (pull_value_usd, moments_pulled, pack_nft_id, sealed_at)
  WHERE (dist_id IS NOT NULL);

DROP INDEX IF EXISTS public.idx_pack_rips_dist_agg_v2;
DROP INDEX IF EXISTS public.idx_pack_rips_dist_agg_v3;
