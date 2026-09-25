-- audit_20260925_cached_listings_v2_storefront_reconcile_values
--
-- Trevor 2026-09-25: "do it" — give LaLiga Golazos a listing source that survives
-- Flowty switching its API off.
--
-- WHY. app/api/cron/golazos-storefront-reconcile walks each known Golazos seller's
-- Dapper NFTStorefrontV2 and reconciles this table against it (measured 09-25:
-- 1,391 live listings across 442 editions on-chain vs 514 "open" rows / 200
-- editions here, 154 ghosts, nothing ever closed). It needs two new values:
--   source 'storefront_v2'     a listing read from storefront STATE, not from a
--                              ListingAvailable event, so it has no block_height /
--                              tx_hash / event_index. It is deliberately NOT in
--                              direct_source_has_chain_meta's list: that CHECK
--                              exists to stop an event row losing its provenance,
--                              and a state read never had any.
--   completed_status 'ghosted' the listing still exists but the seller no longer
--                              holds the moment, so it cannot be bought
--   completed_status 'vanished' the listing is no longer in the storefront and no
--                              ListingCompleted was recorded (so purchased vs
--                              cancelled is unknown — not claimed)
-- Existing values are unchanged. Constraints are re-added NOT VALID then
-- VALIDATEd so the ACCESS EXCLUSIVE lock covers only the swap (227k rows, 81 MB).
--
-- REVERT: close/delete the rows carrying the new values, then restore the two
-- CHECKs to their prior lists (source: direct, direct_v1, direct_v2, flowty;
-- completed_status: purchased, cancelled, expired).

ALTER TABLE public.cached_listings_v2
  DROP CONSTRAINT cached_listings_v2_source_check,
  ADD CONSTRAINT cached_listings_v2_source_check
    CHECK (source = ANY (ARRAY['direct'::text, 'direct_v1'::text, 'direct_v2'::text, 'flowty'::text, 'storefront_v2'::text])) NOT VALID,
  DROP CONSTRAINT cached_listings_v2_completed_status_check,
  ADD CONSTRAINT cached_listings_v2_completed_status_check
    CHECK (completed_status = ANY (ARRAY['purchased'::text, 'cancelled'::text, 'expired'::text, 'ghosted'::text, 'vanished'::text])) NOT VALID;

ALTER TABLE public.cached_listings_v2 VALIDATE CONSTRAINT cached_listings_v2_source_check;
ALTER TABLE public.cached_listings_v2 VALIDATE CONSTRAINT cached_listings_v2_completed_status_check;
