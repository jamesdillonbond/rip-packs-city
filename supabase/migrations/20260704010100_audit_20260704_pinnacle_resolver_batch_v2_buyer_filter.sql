-- Issue 1 (companion to the covering index): make pinnacle_get_unresolved_batch_v2
-- return actionable targets. ~2,249 of the ~7.5k unresolved sales rows have a
-- NULL buyer_address (no on-chain account to query), and because the batch is
-- nft_id-ordered they permanently occupied the front of every 100-row batch —
-- the resolver returned ~95 dead rows / ~5 actionable per tick (rows_written=0)
-- and the wmc_targets branch (v10's 32k-moment integration) never ran.
--
-- The edge function already discards NULL-hint rows (no_hint++), so adding
-- `buyer_address IS NOT NULL` to sales_targets is behavior-preserving for what
-- actually resolves; it just fills the batch with resolvable targets and lets
-- the wmc branch surface once the sales backlog thins. INCLUDE(buyer_address) on
-- idx_pinnacle_sales_unresolved_nft keeps this an index-only filter.
--
-- Only sales_targets changed; wmc_targets, the UNION ALL, LIMIT, SECDEF,
-- search_path and STABLE volatility are all preserved verbatim.
-- Revert: restore the prior definition (sales_targets without the
-- `AND ps.buyer_address IS NOT NULL` predicate).
CREATE OR REPLACE FUNCTION public.pinnacle_get_unresolved_batch_v2(p_limit integer DEFAULT 50)
 RETURNS TABLE(nft_id text, source text, hint_address text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH
  sales_targets AS (
    SELECT DISTINCT ON (ps.nft_id)
      ps.nft_id,
      'sales'::text AS source,
      ps.buyer_address AS hint_address,
      ps.sold_at
    FROM pinnacle_sales ps
    WHERE ps.edition_id IS NULL
      AND ps.nft_id IS NOT NULL
      AND ps.buyer_address IS NOT NULL
    ORDER BY ps.nft_id, ps.sold_at DESC
    LIMIT p_limit
  ),
  wmc_targets AS (
    SELECT
      wmc.moment_id AS nft_id,
      'wmc'::text AS source,
      wmc.wallet_address AS hint_address
    FROM wallet_moments_cache wmc
    WHERE wmc.collection_id = (SELECT id FROM collections WHERE slug = 'disney_pinnacle')
      AND NOT EXISTS (SELECT 1 FROM pinnacle_nft_map m WHERE m.nft_id = wmc.moment_id)
      AND NOT EXISTS (SELECT 1 FROM sales_targets st WHERE st.nft_id = wmc.moment_id)
    LIMIT p_limit
  )
  SELECT nft_id, source, hint_address FROM sales_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM wmc_targets
  LIMIT p_limit;
$function$;
