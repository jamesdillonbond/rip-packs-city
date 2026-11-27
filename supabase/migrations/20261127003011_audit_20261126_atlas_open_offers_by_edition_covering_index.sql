-- 2026-11-26 (Claude Code cloud, autonomous pass). A covering index for the open Top Shot OFFER book
-- that sync_edition_offers_from_atlas() step (b) reads every 5 minutes (atlas_listing_verify_tick, job 466).
--
-- WHY. Step (b) asks, for every edition verified in the last 24 h (~2,180), the max open EDITION/PARALLEL
-- offer seen in 24 h. It used idx_tame_open_by_edition_any_kind (product, atlas_edition_id, kind,
-- last_seen_at) and then fetched every matching row from the heap for price_cents / offer_type. The
-- ~82k open offers are scattered over the 689 MB heap and do not stay cached: measured 11-26 4:40 PM PT,
-- 12,224 buffers with 4,440 DISK reads and 4.87 s, back-to-back with a run that read 6,249 pages in 8.3 s.
-- atlas_listing_verify_tick is the largest disk reader in pg_stat_statements since 08-11 (525 M blocks).
--
-- HOW. Partial on the offer book (kind = 'offer' AND NOT completed), the same leading keys, INCLUDE the two
-- columns the subquery filters and aggregates. Measured right after the build: Index Only Scan,
-- 8,877 buffers, 0 disk reads, 901 heap fetches, 47.6 ms (was 4,873 ms); same 2,178 rows. 5.7 MB.
--
-- Built first with CREATE INDEX CONCURRENTLY via execute_sql (11-26 ~4:42 PM PT, indisvalid AND
-- indisready); this statement is a no-op there and builds it on a fresh database (replay-safe).
-- REVERT: DROP INDEX CONCURRENTLY IF EXISTS public.idx_tame_open_offers_by_edition_cover;  (one statement)
SET lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS idx_tame_open_offers_by_edition_cover
  ON public.topshot_atlas_market_events (product, atlas_edition_id, last_seen_at)
  INCLUDE (price_cents, offer_type)
  WHERE ((kind = 'offer'::text) AND (NOT completed));
