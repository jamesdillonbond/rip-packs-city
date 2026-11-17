-- Applied to prod via Supabase MCP on 2026-07-27. Committed here for parity.
-- REPAIR of the 00:35Z false mass-deactivation: ME's /listings endpoint returned
-- 7 rows against a 426-ask book and the (then absence-based) sweep marked 419
-- standing asks dead. The chain shows only 6 delists + 8 sales collection-wide
-- in that window. Restores the rows the 21:38Z sweep last confirmed alive, minus
-- any expired (0) or since-sold (7). 407 rows restored.
--
-- REVERT:
--   UPDATE public.candy_listings SET is_active = false
--    WHERE pda_address IN (SELECT pda_address FROM public.audit_20260727_candy_listings_restored);

CREATE TABLE IF NOT EXISTS public.audit_20260727_candy_listings_restored AS
SELECT pda_address, token_mint, price_usd, last_seen_at
  FROM public.candy_listings
 WHERE NOT is_active
   AND last_seen_at >= '2026-07-26 21:00Z' AND last_seen_at < '2026-07-26 22:00Z'
   AND (expiry IS NULL OR expiry > now())
   AND token_mint NOT IN (
       SELECT nft_id FROM public.sales
        WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
          AND sold_at > '2026-07-26 21:38Z');

ALTER TABLE public.audit_20260727_candy_listings_restored ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260727_candy_listings_restored FROM anon, authenticated;

UPDATE public.candy_listings SET is_active = true
 WHERE pda_address IN (SELECT pda_address FROM public.audit_20260727_candy_listings_restored);
