-- 2026-10-19 (PT) — step 2 of 3: the 2,939 open mislabelled rows with no other copy take their true source, so
-- ListingCompleted (per source) and the V2 reconciler can close them. The ghost table is keyed on
-- (listing_resource_id, source) and is relabelled in the same migration so a relabelled ghost never reads as a live
-- floor. Revert: see 20261020012552.
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
