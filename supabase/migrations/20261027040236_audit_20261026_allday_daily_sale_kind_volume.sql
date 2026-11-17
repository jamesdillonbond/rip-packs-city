-- audit_20261026: All Day analytics Marketplace Breakdown splits by HOW a sale happened (All Day ↔ Top Shot parity, pass 3).
--
-- Every All Day sale carries marketplace = 'nflallday', so get_daily_marketplace_volume gave the Analytics tab's
-- Marketplace Breakdown one row. This reads the SAME sales rows and groups by listing purchase / accepted offer
-- (source = offer_fill) / pack buyback (buyer in buyback_wallets, the sales_market rule). Read 10-26 ~9:05 PM PT over
-- 30 days, both functions: 16,223 sales / $14,367.98 — identical. Split: listings 15,493 / $10,590.98 · accepted offers
-- 721 / $3,759.00 · pack buybacks 9 / $18.00. Service-role only (the route reads it).
--
-- Revert: DROP FUNCTION public.get_allday_daily_sale_kind_volume(timestamptz);
--         (and revert the route's All Day arm — it would 500 on the missing function)

-- anon-exec: revoked (get_allday_daily_sale_kind_volume) — service-role read by /api/market-analytics; REVOKE below.
CREATE OR REPLACE FUNCTION public.get_allday_daily_sale_kind_volume(p_start_iso timestamptz)
 RETURNS TABLE(day date, marketplace text, sale_count bigint, volume_usd numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DATE(s.sold_at) AS day,
         CASE
           WHEN EXISTS (SELECT 1 FROM public.buyback_wallets b
                         WHERE b.collection_id = s.collection_id AND b.wallet_address = s.buyer_address::text) THEN 'allday_buyback'
           WHEN s.source = 'offer_fill' THEN 'allday_offer_fill'
           ELSE 'allday_listing'
         END AS marketplace,
         COUNT(*)::bigint AS sale_count,
         ROUND(COALESCE(SUM(s.price_usd), 0)::numeric, 2) AS volume_usd
    FROM public.sales s
   WHERE s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
     AND s.sold_at >= p_start_iso
   GROUP BY 1, 2
   ORDER BY 1, 2;
$function$;
REVOKE EXECUTE ON FUNCTION public.get_allday_daily_sale_kind_volume(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_daily_sale_kind_volume(timestamptz) TO postgres, service_role;
COMMENT ON FUNCTION public.get_allday_daily_sale_kind_volume(timestamptz) IS
  'NFL All Day daily volume split by HOW the sale happened (listing purchase / accepted offer / pack buyback), over the same sales rows get_daily_marketplace_volume reads, so totals are identical. Every All Day sale carries marketplace = nflallday, so the analytics Marketplace Breakdown was one row (Top Shot parity, 2026-10-26). audit_20261026.';
