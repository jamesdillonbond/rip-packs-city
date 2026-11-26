-- audit_20261125_panini_product_market_cap_coverage_honest
--
-- 2026-11-25 (Claude Code cloud; Trevor: "work through everything you can in this thread, leaving nothing unresolved").
-- WHY. Two low honesty gaps found by the 11-24 review of c8accc6ef (get_panini_product_market_cap, 20261124033821):
--   1. The product page tile reads "<collector_held> of <minted> minted", but collector_held sums only editions with a
--      known holder split while minted sums EVERY cap row — two populations, so the ratio understates when supply is
--      partial (the 10-20 entity-tile sweep fixed the same shape on MarketCapTile).
--   2. refreshed_at = max(computed_at): the page's staleness note fires only when EVERY row is stale. The figures are
--      as old as their oldest row (the min-of-max rule, key-files-and-honesty.md).
-- WHAT. New key minted_supply_known (minted over the same supply-known editions collector_held covers); refreshed_at
-- becomes min(computed_at). Every other key unchanged. Signature, return type, STABLE, search_path, ACL unchanged.
-- Base = live body (md5 1d53b820bc9d87493da7fc644cf31ef4 = 20261124033821's), asserted below.
--
-- anon-exec: unchanged (get_panini_product_market_cap) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role).
-- REVERT: re-apply 20261124033821_audit_20261123_panini_product_market_cap.sql.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_panini_product_market_cap(text)'::regprocedure)
     <> '1d53b820bc9d87493da7fc644cf31ef4' THEN
    RAISE EXCEPTION 'get_panini_product_market_cap live body drifted from the 20261124033821 base; re-read before replacing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_panini_product_market_cap(p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (
    SELECT r.product_set_ids FROM public.panini_product_rollup r WHERE r.slug = p_slug LIMIT 1
  ), eds AS (
    SELECT pe.external_id FROM r JOIN public.panini_editions pe ON pe.product_set_id = ANY (r.product_set_ids)
  ), m AS (
    SELECT c.* FROM eds
      JOIN public.market_cap_current c
        ON c.collection_slug = 'panini_blockchain' AND c.grain = 'edition' AND c.match_key = eds.external_id
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM m) THEN NULL ELSE jsonb_build_object(
    'editions', (SELECT count(*) FROM eds),
    'editions_with_cap_row', (SELECT count(*) FROM m),
    'editions_supply_known', (SELECT COALESCE(sum(editions_supply_known), 0) FROM m),
    'editions_priced', (SELECT count(*) FROM m WHERE mcap_usd IS NOT NULL),
    'minted', (SELECT sum(minted) FROM m),
    -- 2026-11-25: the denominator for collector_held — the same supply-known editions, never every row.
    'minted_supply_known', (SELECT sum(minted) FROM m WHERE editions_supply_known > 0),
    'burned', (SELECT sum(burned) FROM m),
    'issuer_held', (SELECT sum(issuer_held) FROM m),
    'collector_held', (SELECT sum(collector_held) FROM m WHERE editions_supply_known > 0),
    'mcap_usd', (SELECT round(sum(mcap_usd), 2) FROM m),
    'mcap_minted_usd', (SELECT round(sum(mcap_minted_usd), 2) FROM m),
    -- 2026-11-25: as old as the OLDEST row (was max, so staleness only showed when every row was stale).
    'refreshed_at', (SELECT min(computed_at) FROM m)
  ) END
$function$;
