-- 2026-10-18 ~1:10 PM PT (Cowork cloud; Trevor "Keep going"). Inbox 2026-10-18T1508Z (LOW): the
-- collection overview market-cap tile read `market_cap_current WHERE grain='collection' AND is_primary`
-- has no index led by grain, so it walked the whole (collection_slug, grain, match_key) PK index —
-- 1,145 buffers to return 7 rows — on every /[collection]/overview render, and more right after the
-- 2-hourly delete-then-insert refresh (jobid 688) leaves dead entries. This partial index holds only
-- the collection-grain primary rows. Measured after apply: Index Only Scan, 2 buffers, 0.1 ms.
-- REVERT: DROP INDEX public.market_cap_current_collection_primary_idx;
CREATE INDEX IF NOT EXISTS market_cap_current_collection_primary_idx
  ON public.market_cap_current (collection_slug)
  INCLUDE (mcap_usd)
  WHERE grain = 'collection' AND is_primary;
