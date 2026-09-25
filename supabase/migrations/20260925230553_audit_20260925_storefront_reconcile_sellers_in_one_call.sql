-- audit_20260925_storefront_reconcile_sellers_in_one_call
--
-- The storefront reconciler (app/api/cron/golazos-storefront-reconcile) built its
-- seller list by paging cached_listings_v2 and sales 1,000 rows at a time. Fine for
-- Golazos (~4k listing rows, ~1.4k sales/yr); for NFL All Day it would be ~100
-- round trips a run (tens of thousands of listing rows, 12,209 sales in 30 d). This
-- returns the distinct seller set in ONE call, as an ARRAY — a SETOF would be
-- clamped at PostgREST's 1,000-row cap and All Day has ~1,500 sellers.
--
-- Sellers = anyone with a Dapper-storefront listing row (direct_v1 / direct_v2 /
-- storefront_v2; the Flowty fork 'direct' is excluded — its listings are
-- unpurchasable) plus anyone who sold in the collection within p_sale_days. Flow
-- addresses only (lowercase hex, 0x + 16).
--
-- anon-exec: REVOKEd from PUBLIC, anon, authenticated below — an internal cron
-- helper, called by the route with the service role.
--
-- REVERT: DROP FUNCTION public.storefront_reconcile_sellers(uuid, integer);

CREATE OR REPLACE FUNCTION public.storefront_reconcile_sellers(p_collection_id uuid, p_sale_days integer)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(array_agg(s ORDER BY s), '{}'::text[])
  FROM (
    SELECT lower(cl.seller_address) AS s
    FROM cached_listings_v2 cl
    WHERE cl.collection_id = p_collection_id
      AND cl.source IN ('direct_v1', 'direct_v2', 'storefront_v2')
      AND cl.seller_address IS NOT NULL
    UNION
    SELECT lower(sa.seller_address)
    FROM sales sa
    WHERE sa.collection_id = p_collection_id
      AND sa.sold_at > now() - make_interval(days => p_sale_days)
      AND sa.seller_address IS NOT NULL
  ) x
  WHERE s ~ '^0x[0-9a-f]{16}$';
$function$;

REVOKE EXECUTE ON FUNCTION public.storefront_reconcile_sellers(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storefront_reconcile_sellers(uuid, integer) TO service_role;
