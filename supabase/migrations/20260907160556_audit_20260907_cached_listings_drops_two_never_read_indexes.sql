-- audit_20260907: cached_listings carried 12 indexes on 19K rows; two have never been read.
--
-- Found closing the WAL watch on the Atlas tick (`atlas_listing_verify_tick`, 09-07 16:00Z: 7.8 MB of
-- WAL and 1,385 dirtied pages per 2-min tick AFTER the syncs went differential — the WAL is full-page
-- images of the pages each tick touches for the first time since the last checkpoint, and a row written
-- to cached_listings touches one page per index). `pg_stat_user_indexes` since the database's stats
-- began (never reset): `idx_cl_listing_resource_id` 0 scans, `idx_cached_listings_tier` 5 scans (the
-- (collection_id, tier) composite next to it has 33,665). No function, view or route filters
-- cached_listings on listing_resource_id (the column is only ever selected; the partial index was never
-- planned once), and a bare `tier` filter is served by the composite.
--
-- Dropping the two removes 2 of the 12 index pages every insert dirties. Marginal by design — the tick's
-- WAL (~13 MB across both Atlas ticks per 2 min ≈ 9 GB/day) is ~0.5 % of the tier's IO budget, so this is
-- a hygiene drop with a measurement attached, not a saturation fix.
--
-- REVERT:
--   CREATE INDEX idx_cl_listing_resource_id ON public.cached_listings (listing_resource_id) WHERE listing_resource_id IS NOT NULL;
--   CREATE INDEX idx_cached_listings_tier ON public.cached_listings (tier);

DROP INDEX IF EXISTS public.idx_cl_listing_resource_id;
DROP INDEX IF EXISTS public.idx_cached_listings_tier;
