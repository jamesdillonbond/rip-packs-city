-- get_wallet_best_offer_total(p_wallet)
-- Collection-agnostic sibling of get_pinnacle_wallet_best_offer_total: sums the
-- best (MAX) standing DapperOffersV2 bid per moment the wallet holds, across ALL
-- collections, from the on-chain offer feed marketplace_offers (nft_id = the
-- moment_id; DUC ~= USD; offer_state='LISTED' == a live standing offer). Powers a
-- "standing offers on your holdings" figure in the AI concierge check_wallet tool.
-- The (collection_id, nft_id) partial LISTED index makes the wmc join index-driven.
--
-- SECURITY DEFINER + service_role-only EXECUTE (anon/authenticated revoked),
-- read via supabaseAdmin. Revert: DROP FUNCTION public.get_wallet_best_offer_total(text);
CREATE OR REPLACE FUNCTION public.get_wallet_best_offer_total(p_wallet text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH held AS (
    SELECT wmc.collection_id, wmc.moment_id
    FROM wallet_moments_cache wmc
    WHERE wmc.wallet_address = p_wallet
  ),
  best AS (
    SELECT mo.collection_id, mo.nft_id, MAX(mo.offer_price) AS best_offer
    FROM marketplace_offers mo
    JOIN held h ON h.collection_id = mo.collection_id AND h.moment_id = mo.nft_id
    WHERE mo.offer_state = 'LISTED'
      AND mo.currency = 'DUC'
      AND mo.offer_price > 0
    GROUP BY mo.collection_id, mo.nft_id
  )
  SELECT ROUND(COALESCE(SUM(best_offer), 0), 2) FROM best;
$function$;

REVOKE ALL ON FUNCTION public.get_wallet_best_offer_total(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_wallet_best_offer_total(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_wallet_best_offer_total(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_best_offer_total(text) TO service_role;
