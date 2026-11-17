-- 2026-10-19 (PT) — NFL All Day: Dapper listings mislabelled source='direct' (the Flowty fork). Step 1 of 3: backup + plan.
-- allday-listings-retry and /api/admin/listing-retry-force hardcoded source 'direct' for every listing they resolved
-- (code fix d234a6fea, lib/allday/listing-source.ts). Verified on chain via pg_net, 40/40 sampled transactions: 'direct'
-- rows listed on/after 2026-05-15 are Dapper V1 NFTStorefront (custom_id NULL) or Dapper V2 NFTStorefrontV2
-- (DAPPER_MARKETPLACE); the fork's createListing asserts false since then. The indexer closes per source, so a sale or
-- cancel never closed them. Re-measured 6:24 PM PT: 8,656 open, 5,717 of them duplicating a storefront_v2 row (or a
-- correctly-sourced twin), 2,939 with no other copy. Known-issues #197.
-- Revert (all 3 steps): UPDATE cached_listings_v2 v SET source='direct' FROM audit_20261019_allday_direct_mislabel b
--   WHERE b.action='relabel' AND v.listing_resource_id=b.listing_resource_id AND v.source=b.new_source;
--   (same swap on allday_listings_sold_after_listing);
--   UPDATE cached_listings_v2 SET completed_at=NULL, completed_status=NULL WHERE completed_status='duplicate';
CREATE TABLE public.audit_20261019_allday_direct_mislabel AS
SELECT v.listing_resource_id,
       CASE WHEN EXISTS (SELECT 1 FROM public.cached_listings_v2 x
                         WHERE x.listing_resource_id = v.listing_resource_id
                           AND x.source IN ('storefront_v2', CASE WHEN v.custom_id IS NULL THEN 'direct_v1' ELSE 'direct_v2' END))
            THEN 'delete_duplicate' ELSE 'relabel' END AS action,
       CASE WHEN v.custom_id IS NULL THEN 'direct_v1' ELSE 'direct_v2' END AS new_source,
       v AS row_data
FROM public.cached_listings_v2 v
WHERE v.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND v.source = 'direct'
  AND v.completed_at IS NULL
  AND v.listed_at >= '2026-05-15';
ALTER TABLE public.audit_20261019_allday_direct_mislabel ENABLE ROW LEVEL SECURITY;
