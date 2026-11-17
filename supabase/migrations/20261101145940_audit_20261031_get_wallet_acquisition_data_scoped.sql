-- get_wallet_acquisition_data_scoped: the collection-scoped read behind
-- /api/wallet-search and /api/cost-basis acquisition enrichment (2026-11-01, #142).
--
-- get_wallet_acquisition_data(p_wallet, p_moment_ids) matches moment_acquisitions
-- on (wallet, nft_id) and DISTINCT ON (nft_id) keeps the NEWEST row across
-- collections, so a wallet's All Day moment can answer with its Top Shot
-- namesake's method / Paid (41 colliding rows in 11 wallets, measured
-- 2026-10-31). Changing that function's signature in place needs DROP FUNCTION
-- (an overload would make 2-named-arg PostgREST calls ambiguous), and Supabase's
-- confirmation for the DROP never reached the cloud session in three tries.
-- So this is a NEW function with the same body plus the collection predicate;
-- both callers move to it. p_collection_id NULL = wallet-wide (cost-basis with
-- no ?collection). The old function is left in place, now uncalled from the repo;
-- dropping it is a follow-up for a session that can answer the DROP prompt.
--
-- Live-verified after apply: All Day 10565124 in 0xbd94… → 0 rows (was the Top
-- Shot $65); Top Shot scope → 65. ACL: postgres + service_role only.

CREATE OR REPLACE FUNCTION public.get_wallet_acquisition_data_scoped(p_wallet text, p_moment_ids text[], p_collection_id uuid)
 RETURNS TABLE(moment_id text, acquisition_method text, buy_price numeric, loan_principal numeric, acquired_date timestamp with time zone, source_wallet text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT ON (ma.nft_id)
    ma.nft_id AS moment_id,
    ma.acquisition_method,
    ma.buy_price,
    ma.loan_principal,
    ma.acquired_date,
    ma.source_wallet
  FROM moment_acquisitions ma
  WHERE ma.wallet = p_wallet
    AND ma.nft_id = ANY(p_moment_ids)
    AND (p_collection_id IS NULL OR ma.collection_id = p_collection_id)
  ORDER BY ma.nft_id, ma.created_at DESC;
$function$;
REVOKE EXECUTE ON FUNCTION public.get_wallet_acquisition_data_scoped(text, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_acquisition_data_scoped(text, text[], uuid) TO service_role;
