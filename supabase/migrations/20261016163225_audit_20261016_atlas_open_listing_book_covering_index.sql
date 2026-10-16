-- 2026-10-16 (Claude Code cloud). A covering index for the open Top Shot listing book that
-- sync_ts_listings_from_atlas() rebuilds every 5 minutes (atlas_listing_verify_tick, pg_cron).
--
-- WHY. The tick's `_open24` read (open, mapped, verified-in-24 h nba listings: ~34.5 k rows) used
-- idx_tame_open_listing_by_seen (product, last_seen_at, nft_id) and then fetched every row from the
-- heap. In index order the window revisits its 12.6 k heap pages: 31,976 buffers, 12,784 of them DISK
-- reads, 6.76 s of the tick's ~10 s. It ran 288x a day, and atlas_listing_verify_tick was the largest
-- disk reader in the 10-16 06:05-16:05 UTC pgss window (2.11 M blocks read over 120 calls).
--
-- HOW. Same keys and same partial predicate as idx_tame_open_listing_by_seen, plus INCLUDE of every
-- event column the read selects. It is a strict superset of the old index, so every query that could use
-- the old one can use this one identically. The table is autovacuumed ~every 3 h (scale factor 0.02),
-- so nearly every page is all-visible and the read becomes an index-only scan. Measured right after the
-- build: Index Only Scan, 8,535 buffers, 0 disk reads, 1,738 heap fetches, 39 ms (was 6,762 ms).
-- 70 MB (the old partial index is 177 MB, bloated; retiring it is a separate change).
--
-- Built first with CREATE INDEX CONCURRENTLY via execute_sql (10-16 ~9:31 AM PT, indisvalid); this
-- statement is a no-op there and builds it on a fresh database (replay-safe).
-- REVERT: DROP INDEX public.idx_tame_open_listing_seen_cover;
SET lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS idx_tame_open_listing_seen_cover
  ON public.topshot_atlas_market_events (product, last_seen_at, nft_id)
  INCLUDE (uuid, atlas_edition_id, set_id_onchain, play_id_onchain, serial_number, price_cents,
           seller_address, tier, listed_at, listing_resource_id)
  WHERE ((kind = 'listing'::text) AND (NOT completed) AND (nft_id IS NOT NULL));
