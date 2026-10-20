-- 2026-10-19 (PT) — step 3 of 3: the 5,717 open mislabelled rows that duplicate a storefront_v2 (or correctly-sourced)
-- row are CLOSED with a new completed_status 'duplicate', not deleted: the MCP apply of the DELETE hung three times
-- (60 s, nothing applied, plan a trivial PK nested loop), and a close is reversible and drops the row from every
-- reader (they all filter completed_at IS NULL) the same way. Revert:
--   UPDATE cached_listings_v2 SET completed_at=NULL, completed_status=NULL WHERE completed_status='duplicate';
ALTER TABLE public.cached_listings_v2
  DROP CONSTRAINT cached_listings_v2_completed_status_check,
  ADD CONSTRAINT cached_listings_v2_completed_status_check
    CHECK (completed_status = ANY (ARRAY['purchased'::text, 'cancelled'::text, 'expired'::text, 'ghosted'::text, 'vanished'::text, 'unpurchasable'::text, 'duplicate'::text])) NOT VALID;
ALTER TABLE public.cached_listings_v2 VALIDATE CONSTRAINT cached_listings_v2_completed_status_check;

UPDATE public.cached_listings_v2 v
SET completed_at = now(), completed_status = 'duplicate'
FROM public.audit_20261019_allday_direct_mislabel b
WHERE b.action = 'delete_duplicate'
  AND v.listing_resource_id = b.listing_resource_id
  AND v.source = 'direct'
  AND v.completed_at IS NULL;
