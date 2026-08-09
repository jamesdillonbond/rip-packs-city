-- audit_20260809_index_wmc_allday_lock_picker
--
-- Completes the allday-lock-refresh picker fix started in
-- 20260809010000_audit_20260809_allday_lock_picker_skipscan.sql. That migration
-- re-shaped get_allday_lock_refresh_wallets from O(rows) to O(wallets); this one
-- makes each of those ~213 wallet hops a single index descent.
--
-- Why it was still slow after the rewrite: the skip-scan fell back to
-- idx_wmc_lock_wallet_coll (wallet_address, collection_id, lock_checked_at),
-- where collection_id is the SECOND column. So each "next All Day wallet" hop
-- had to walk forward through the index entries of intervening wallets holding
-- no All Day rows. Measured, one hop:
--
--   Index Only Scan using idx_wmc_lock_wallet_coll  (actual time=280.034 rows=1)
--     Index Cond: ((wallet_address > '0x0') AND (collection_id = 'dee28451-…'))
--     Heap Fetches: 0     Buffers: shared hit=4 read=42
--
-- 42 index pages read from disk to return one row, x213 hops. (Heap Fetches: 0 --
-- pure index walking, not a visibility-map/VACUUM problem.)
--
-- PARTIAL rather than a full (collection_id, wallet_address, lock_checked_at)
-- index: same plan quality, a fraction of the size, and only All Day rows pay the
-- write-amplification cost. That matters here because lock_checked_at is already
-- indexed twice, so every lock stamp is a non-HOT update that rewrites every
-- index on this table -- a third full index would tax all ~2.1M rows to serve
-- ~396k. Precedent on this same table: idx_wmc_candy_holder_cover.
-- Estimated ~18 MB; actual 3,120 kB (btree dedup on heavily repeated
-- wallet_address values).
--
-- ⚠ This does NOT supersede idx_wmc_lockcheck_order (collection_id,
-- lock_checked_at) -- keep it. That one serves get_lock_check_batch, the generic
-- multi-collection picker, whose "WHERE collection_id = … ORDER BY
-- lock_checked_at NULLS FIRST LIMIT n" is an ordered scan where the LIMIT
-- genuinely bounds work. Dropping it would break that cron the same way this one
-- broke.
--
-- Built as a plain (non-CONCURRENT) index inside a verified-idle window (1 active
-- backend, nothing running >15s), guarded by lock_timeout so lock acquisition
-- cannot pile up on a hot table -- the documented path here, since CONCURRENTLY
-- cannot run through the Supabase MCP (not transaction-safe; a disconnect at the
-- tool cap leaves an INVALID index). Same method used for idx_wmc_lockcheck_order
-- on 2026-07-16.
--
-- Verified after: indisvalid/indisready true; the probe above went
-- 280 ms / 42 pages read -> 0.112 ms / 4 pages, 0 disk reads; the full picker
-- get_allday_lock_refresh_wallets(60) went ~1.5s -> 69 ms.
--
-- Revert: DROP INDEX CONCURRENTLY IF EXISTS public.idx_wmc_allday_lock_picker;
--   (the picker still returns correct results without it, just slower --
--    it falls back to idx_wmc_lock_wallet_coll)

SET LOCAL lock_timeout = '4s';
SET LOCAL maintenance_work_mem = '128MB';

CREATE INDEX IF NOT EXISTS idx_wmc_allday_lock_picker
  ON public.wallet_moments_cache (wallet_address, lock_checked_at NULLS FIRST)
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;
