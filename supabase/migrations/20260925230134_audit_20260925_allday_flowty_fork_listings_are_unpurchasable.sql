-- audit_20260925_allday_flowty_fork_listings_are_unpurchasable
--
-- WHY. The Flowty fork of NFTStorefrontV2 (A.3cdbb3d569211ff3) has purchases
-- DISABLED on-chain: its deployed Listing.purchase() begins
--   assert(false, message: "Purchases have been disabled. See Flowty discord for more details.")
-- and createListing() asserts false too (read from the deployed source 2026-09-25).
-- The NFL All Day indexer maps that storefront to source 'direct', and 21,670 such
-- listings sat OPEN in cached_listings_v2 — unbuyable, but counted as live asks by
-- every reader that does not filter on source: allday_edition_floor_ask (the ask
-- CEILING fmv-recalc caps All Day FMV at), refresh_allday_ask_fmv_from_listings
-- (job 19), the All Day sniper/deals reads and the market route.
--
-- MEASURED 2026-09-25 ~4:15 PM PT: of 4,505 All Day editions with an open ask, the
-- floor of 2,724 was an unbuyable Flowty-fork listing, with the cheapest BUYABLE
-- listing a median 2.57x higher; 355 had only Flowty-fork asks. ~724 editions had an
-- FMV at or below that fake floor (MEDIUM 287, LOW 173+88 haircut, ASK_ONLY 169,
-- HIGH 4). Dapper's V1 (direct_v1) and V2 (direct_v2) storefronts ARE buyable.
-- Disney Pinnacle's 'direct' rows are Dapper's V2 storefront (its indexer maps it so)
-- and are NOT touched.
--
-- WHAT. Close every open All Day 'direct' row with a new completed_status
-- 'unpurchasable' (the listing still exists on-chain but cannot be bought), so every
-- reader drops it at once without a per-reader patch. No new rows can arrive: the
-- fork's createListing is disabled, and a later ListingCompleted from the fork only
-- updates rows WHERE completed_at IS NULL. Prices then re-derive on their normal
-- cycles against the buyable floor; no pricing code changes here.
--
-- REVERT: UPDATE public.cached_listings_v2 v SET completed_at = NULL, completed_status = NULL
--   FROM public.audit_20260925_allday_flowty_fork_unpurchasable b
--   WHERE v.listing_resource_id = b.listing_resource_id AND v.source = b.source;

ALTER TABLE public.cached_listings_v2
  DROP CONSTRAINT cached_listings_v2_completed_status_check,
  ADD CONSTRAINT cached_listings_v2_completed_status_check
    CHECK (completed_status = ANY (ARRAY['purchased'::text, 'cancelled'::text, 'expired'::text, 'ghosted'::text, 'vanished'::text, 'unpurchasable'::text])) NOT VALID;
ALTER TABLE public.cached_listings_v2 VALIDATE CONSTRAINT cached_listings_v2_completed_status_check;

CREATE TABLE public.audit_20260925_allday_flowty_fork_unpurchasable AS
SELECT listing_resource_id, source, edition_id, price_usd
FROM public.cached_listings_v2
WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND source = 'direct'
  AND completed_at IS NULL;
ALTER TABLE public.audit_20260925_allday_flowty_fork_unpurchasable ENABLE ROW LEVEL SECURITY;

UPDATE public.cached_listings_v2
SET completed_at = now(), completed_status = 'unpurchasable'
WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND source = 'direct'
  AND completed_at IS NULL;

DO $post$
DECLARE n_open int; n_backup int; n_pinnacle int;
BEGIN
  SELECT count(*) INTO n_open FROM public.cached_listings_v2
    WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND source = 'direct' AND completed_at IS NULL;
  SELECT count(*) INTO n_backup FROM public.audit_20260925_allday_flowty_fork_unpurchasable;
  SELECT count(*) INTO n_pinnacle FROM public.cached_listings_v2 WHERE completed_status = 'unpurchasable'
    AND collection_id <> 'dee28451-5d62-409e-a1ad-a83f763ac070';
  IF n_open <> 0 THEN RAISE EXCEPTION 'open All Day direct rows remain: %', n_open; END IF;
  IF n_backup < 20000 THEN RAISE EXCEPTION 'backup smaller than measured (%): scope drifted', n_backup; END IF;
  IF n_pinnacle <> 0 THEN RAISE EXCEPTION 'non-All-Day rows touched: %', n_pinnacle; END IF;
END $post$;
