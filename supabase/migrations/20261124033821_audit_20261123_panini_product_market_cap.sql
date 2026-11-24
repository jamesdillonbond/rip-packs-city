-- audit_20261123: Panini PRODUCT market cap (2026-11-23 night, Panini parity pass 3; Trevor: "Do it all").
--
-- Top Shot's series page (the product page's counterpart) carries a Market Cap tile; market_cap_current has no
-- product grain for Panini (its 'set' grain is a set NAME, which #204 hides on product-scoped sets because one name
-- spans several products). The product's cap is the sum of its editions' rows on the 'edition' grain — the same
-- rows every Panini edition page's tile shows (collector-held × FMV; burned and issuer-held stock out). The function
-- returns the sums plus coverage (editions with a known supply split / with a price, of the editions RPC has), so
-- the tile can say what is missing — an edition with no cap row or no price is counted, never summed as $0. No rank:
-- ranking products would read every Panini edition row per render (~220k buffers), so the tile does not claim one.
-- Measured 11-23 on 2026 WC Soccer (5,361 edition rows): ~26k buffers / 0.26 s cold, read once per 30-min ISR window.
-- NULL = unknown product slug, or no edition row yet.
-- Revert: DROP FUNCTION public.get_panini_product_market_cap(text);

-- anon-exec: revoked (get_panini_product_market_cap) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
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
    'burned', (SELECT sum(burned) FROM m),
    'issuer_held', (SELECT sum(issuer_held) FROM m),
    'collector_held', (SELECT sum(collector_held) FROM m WHERE editions_supply_known > 0),
    'mcap_usd', (SELECT round(sum(mcap_usd), 2) FROM m),
    'mcap_minted_usd', (SELECT round(sum(mcap_minted_usd), 2) FROM m),
    'refreshed_at', (SELECT max(computed_at) FROM m)
  ) END
$function$;

REVOKE ALL ON FUNCTION public.get_panini_product_market_cap(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_product_market_cap(text) TO service_role;

COMMENT ON FUNCTION public.get_panini_product_market_cap(text) IS
  'Panini product market cap (2026-11-23): sums of the product''s edition rows in market_cap_current (collector-held x FMV), with coverage counts; unpriced editions counted, never summed. No rank. NULL = unknown slug or no rows.';
