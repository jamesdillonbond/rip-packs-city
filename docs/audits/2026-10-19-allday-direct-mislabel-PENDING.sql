-- ⚠ PENDING — NOT APPLIED. Three MCP applies on 2026-10-19 ~6:10 PM PT timed out with nothing applied
-- (destructive-statement confirmation unanswered). Re-measure the counts below, then apply as a migration.
-- 2026-10-19 (PT) — NFL All Day: Dapper listings mislabelled source='direct' (the Flowty fork).
-- allday-listings-retry and /api/admin/listing-retry-force hardcoded source 'direct' for every
-- listing they resolved (code fix: commit "All Day retry paths file a listing under the storefront
-- that emitted it", lib/allday/listing-source.ts). Verified on chain via pg_net, 40/40 sampled
-- transactions: 'direct' rows listed before 2026-05-15 are the fork (A.3cdbb3d569211ff3, its
-- createListing asserts false since); rows listed on/after 2026-05-15 are Dapper V1 NFTStorefront
-- (custom_id NULL, 15/15) or Dapper V2 NFTStorefrontV2 (custom_id DAPPER_MARKETPLACE, 15/15).
-- The indexer closes per source, so a sale/cancel never closed them. Measured ~6:00 PM PT, open rows:
--   * 5,715 open V2 rows that the reconciler had ALSO inserted as source='storefront_v2' → the
--     'direct' copy is a duplicate of a row the reconciler keeps true: DELETED (backed up);
--   * 2,935 open V2 + 6 open V1 rows with no other copy → RELABELLED to direct_v2 / direct_v1, so
--     ListingCompleted and the V2 reconciler can close them from now on.
-- The ghost table (allday_listings_sold_after_listing, keyed on (listing_resource_id, source)) is
-- relabelled in the same transaction so a relabelled ghost never reads as a live floor.
-- NOT touched: the 21,060 CLOSED rows of this class that 20260925230134 closed 'unpurchasable'
-- (known-issues; their live state needs a per-listing chain check, and reopening on a guess
-- would publish dead asks).
-- Revert: DELETE FROM cached_listings_v2 v USING audit_20261019_allday_direct_mislabel b
--           WHERE b.action='relabel' AND v.listing_resource_id=b.listing_resource_id AND v.source=b.new_source;
--         INSERT INTO cached_listings_v2 SELECT (b.row_data).* FROM audit_20261019_allday_direct_mislabel b;
--         (and the same source swap back on allday_listings_sold_after_listing).

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

DELETE FROM public.cached_listings_v2 v
USING public.audit_20261019_allday_direct_mislabel b
WHERE b.action = 'delete_duplicate'
  AND v.listing_resource_id = b.listing_resource_id
  AND v.source = 'direct';

UPDATE public.cached_listings_v2 v
SET source = b.new_source
FROM public.audit_20261019_allday_direct_mislabel b
WHERE b.action = 'relabel'
  AND v.listing_resource_id = b.listing_resource_id
  AND v.source = 'direct';

UPDATE public.allday_listings_sold_after_listing g
SET source = b.new_source
FROM public.audit_20261019_allday_direct_mislabel b
WHERE b.action = 'relabel'
  AND g.listing_resource_id = b.listing_resource_id
  AND g.source = 'direct';
