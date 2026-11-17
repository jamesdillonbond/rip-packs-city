-- get_pinnacle_wallet_best_offer_total(p_wallet)
-- Sums the best (max) standing DapperOffersV2 bid per Pinnacle pin the wallet
-- holds, from the collection-agnostic on-chain offer feed marketplace_offers
-- (nft_id = the pin's moment_id; DUC ~= USD; offer_state='LISTED' is a live
-- standing offer). Full-wallet (reads all held rows from wallet_moments_cache,
-- not the paginated moment page), mirroring get_pinnacle_wallet_total_fmv.
--
-- Returns 0 today because no Pinnacle offer ingest exists yet (marketplace_offers
-- has 0 disney_pinnacle rows). It lights up automatically the moment a Pinnacle
-- DapperOffersV2 offer is ingested here -- nothing else needs to change.
--
-- SECURITY DEFINER + service_role-only EXECUTE (anon/authenticated revoked),
-- read via supabaseAdmin from /api/pinnacle-wallet. Follow-up when Pinnacle
-- offers actually land: add a partial index on marketplace_offers
-- (nft_id WHERE collection_id = pinnacle AND offer_state='LISTED') so the
-- per-wallet join stops seq-scanning the partitioned parent.
CREATE OR REPLACE FUNCTION public.get_pinnacle_wallet_best_offer_total(p_wallet text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH held AS (
    SELECT wmc.moment_id
    FROM wallet_moments_cache wmc
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
  ),
  best AS (
    SELECT mo.nft_id, MAX(mo.offer_price) AS best_offer
    FROM marketplace_offers mo
    JOIN held h ON h.moment_id = mo.nft_id
    WHERE mo.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
      AND mo.offer_state = 'LISTED'
      AND mo.currency = 'DUC'
      AND mo.offer_price > 0
    GROUP BY mo.nft_id
  )
  SELECT ROUND(COALESCE(SUM(best_offer), 0), 2) FROM best;
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_wallet_best_offer_total(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_pinnacle_wallet_best_offer_total(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_pinnacle_wallet_best_offer_total(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_wallet_best_offer_total(text) TO service_role;
