-- Revert for audit_20261104_topshot_sold_listings_close_and_floor_clear (2026-11-04 PT).
-- Run in the Supabase SQL editor, top to bottom. Step 3 restores asks PROVEN SOLD — emergency rollback only.
SELECT cron.unschedule('rpc-ts-sold-floor-clear');
UPDATE public.topshot_atlas_market_events e SET completed = false
  FROM public.topshot_sold_listing_closes c WHERE c.uuid = e.uuid;
UPDATE public.edition_offers o
   SET low_ask = c.old_low_ask, low_ask_serial = c.old_low_ask_serial, low_ask_nft_id = c.old_low_ask_nft_id,
       low_ask_confirmed_at = c.old_confirmed_at
  FROM public.topshot_sold_floor_clears c
 WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND o.external_id = c.external_id AND o.low_ask IS NULL;
DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'ts-sold-floor-clear';
DELETE FROM public.rpc_trust_health_precompute WHERE metric = 'topshot_sold_floor_asks_found';
DROP FUNCTION public.close_sold_topshot_listings_and_floors(int, int);
DROP TABLE public.topshot_sold_floor_clears, public.topshot_sold_listing_closes, public.topshot_sold_listing_close_state;
