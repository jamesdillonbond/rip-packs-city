-- audit_20260924_pack_sales_history_excludes_top_shot_shop
--
-- get_pack_sales_history (the pack page's "top" and "recent" sale lists,
-- lib/pack-dist/fetchers.ts) read every pack_purchases row with event_kind
-- 'secondary_sale'. The ingest labels Top Shot's own shop sales that way too:
-- custom_id 'nba', 34,062 rows, ONE storefront (250688653852667), a fixed price
-- per dist (see 20260924123305). On a shop-sold dist the "recent sales" list was
-- mostly the shop's fixed price — dist 8642 over 14 days: 350 shop sales at
-- $5.00 against 103 collector resales at a $5.74 median.
--
-- FIX: both arms exclude custom_id 'nba'. Same exclusion as
-- pack_market_sales_stats() and get_pack_metrics(). The ingest (Cloudflare worker
-- workers/pack-events-ingest) still writes the label; changing it needs a
-- wrangler deploy.
--
-- anon-exec: intentional — CREATE OR REPLACE of the existing SECURITY DEFINER signature keeps its live ACL (anon/authenticated EXECUTE false, checked 2026-09-24) (get_pack_sales_history)
--
-- REVERT: re-run this CREATE OR REPLACE without the two `custom_id` lines.

CREATE OR REPLACE FUNCTION public.get_pack_sales_history(p_collection_id uuid, p_dist_id text, p_limit integer DEFAULT 10)
 RETURNS TABLE(kind text, buyer_address text, seller_address text, sale_price numeric, sale_currency text, sealed_at timestamp with time zone, tx_hash text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  (SELECT 'top'::text, pp.buyer_address, pp.seller_address, pp.sale_price, pp.sale_currency, pp.sealed_at, pp.tx_hash
   FROM public.pack_purchases pp
   WHERE pp.collection_id = p_collection_id
     AND pp.pack_dist_id = p_dist_id
     AND pp.event_kind = 'secondary_sale'
     AND pp.custom_id IS DISTINCT FROM 'nba'
     AND pp.sale_price > 0
   ORDER BY pp.sale_price DESC, pp.sealed_at DESC
   LIMIT p_limit)
  UNION ALL
  (SELECT 'recent'::text, pp.buyer_address, pp.seller_address, pp.sale_price, pp.sale_currency, pp.sealed_at, pp.tx_hash
   FROM public.pack_purchases pp
   WHERE pp.collection_id = p_collection_id
     AND pp.pack_dist_id = p_dist_id
     AND pp.event_kind = 'secondary_sale'
     AND pp.custom_id IS DISTINCT FROM 'nba'
     AND pp.sale_price > 0
   ORDER BY pp.sealed_at DESC
   LIMIT p_limit);
$function$;
