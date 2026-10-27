-- audit_20261026: NFL All Day Hot Floors — the Top Shot Hot Floors board (sweep pressure) for All Day
-- (All Day ↔ Top Shot parity pass, 2026-10-26 evening PT).
--
-- Top Shot detects a sweep on its Quick-Buy path (sales.proposer_address = the DUC proposer). All Day sales carry
-- NO proposer (read 2026-10-26 ~6:20 PM PT: 2,870 sales_market rows in 7 days, proposer NULL on all of them), so
-- that test cannot apply. Every one of them does carry a buyer, so a sweep here is Panini's definition: ONE buyer
-- taking 3+ copies of an edition with no gap over 60 minutes, over the last p_days (default 7) of `sales_market`
-- (pack buybacks already excluded, #169). Self-trades (seller = buyer) and system accounts
-- (flowty_excluded_addresses, the 10-20 Top Collector lesson) are excluded. Buyers are COUNTED, never named.
--
-- Measured before shipping (2026-10-26 ~6:25 PM PT): 65 swept editions, 15 sweepers (all named collector accounts,
-- none excluded), 335 swept sales, $443 in 7 days; the function returns the top 50. Warm read 34 ms / 6.3k buffers
-- (cold 5.1 s on disk reads of the per-edition floor lookup) — served by a page that revalidates every 300 s, so no MV.
-- Floor = allday_edition_floor_ask (ghost listings excluded) with its last on-chain check; FMV = edition_fmv_current.
-- Anon cannot execute (served by the page's service-role read).
--
-- Revert: DROP FUNCTION public.get_allday_hot_floors(integer);

-- anon-exec: revoked (get_allday_hot_floors) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_allday_hot_floors(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH s AS (
    SELECT sm.edition_id AS ed, sm.buyer_address AS buyer, sm.sold_at, sm.price_usd,
           sm.sold_at - lag(sm.sold_at) OVER (PARTITION BY sm.edition_id, sm.buyer_address ORDER BY sm.sold_at) AS gap
      FROM public.sales_market sm
     WHERE sm.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
       AND sm.sold_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 30))
       AND sm.buyer_address IS NOT NULL
       AND sm.edition_id IS NOT NULL
       AND COALESCE(sm.seller_address, '') <> sm.buyer_address
       AND NOT EXISTS (SELECT 1 FROM public.flowty_excluded_addresses x WHERE lower(x.address) = lower(sm.buyer_address))
  ), sess AS (
    SELECT ed, buyer, sold_at, price_usd,
           sum(CASE WHEN gap IS NULL OR gap > interval '60 minutes' THEN 1 ELSE 0 END)
             OVER (PARTITION BY ed, buyer ORDER BY sold_at) AS sid
      FROM s
  ), g AS (
    SELECT ed, buyer, sid, count(*) AS n, sum(price_usd) AS spend, max(sold_at) AS t1
      FROM sess GROUP BY 1, 2, 3 HAVING count(*) >= 3
  ), e AS (
    SELECT ed, count(DISTINCT buyer)::int AS sweep_buyers, sum(n)::int AS swept_sales,
           sum(spend) AS swept_spend, max(t1) AS last_swept_at
      FROM g GROUP BY ed
  ), top AS (
    SELECT * FROM e ORDER BY sweep_buyers DESC, swept_sales DESC, swept_spend DESC NULLS LAST, ed LIMIT 50
  )
  SELECT jsonb_build_object(
    'days', LEAST(GREATEST(COALESCE(p_days, 7), 1), 30),
    'newest_sale_at', (SELECT max(sold_at) FROM public.sales_market
                        WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
                          AND sold_at > now() - interval '30 days'),
    'editions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'external_id', ed2.external_id, 'player_name', ed2.player_name, 'set_name', ed2.set_name,
               'tier', ed2.tier::text, 'circulation_count', ed2.circulation_count,
               'thumbnail_url', ed2.thumbnail_url,
               'sweep_buyers', t.sweep_buyers, 'swept_sales', t.swept_sales, 'swept_spend', round(t.swept_spend, 2),
               'last_swept_at', t.last_swept_at,
               'floor_ask', fa.floor_ask, 'floor_ask_verified_at', fa.floor_ask_verified_at,
               'fmv_usd', f.fmv_usd)
             ORDER BY t.sweep_buyers DESC, t.swept_sales DESC, t.swept_spend DESC NULLS LAST, t.ed)
        FROM top t
        JOIN public.editions ed2 ON ed2.id = t.ed
        LEFT JOIN LATERAL (SELECT a.floor_ask, a.floor_ask_verified_at FROM public.allday_edition_floor_ask a
                            WHERE a.edition_id = t.ed LIMIT 1) fa ON true
        LEFT JOIN public.edition_fmv_current f ON f.edition_id = t.ed), '[]'::jsonb))
$function$;

REVOKE EXECUTE ON FUNCTION public.get_allday_hot_floors(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_hot_floors(integer) TO postgres, service_role;

COMMENT ON FUNCTION public.get_allday_hot_floors(integer) IS
  'NFL All Day Hot Floors (Top Shot parity, 2026-10-26): editions where one buyer took 3+ copies with no gap over 60 min (a sweep), last p_days (default 7, clamped 1..30) of sales_market (buybacks excluded). All Day sales carry no proposer, so Top Shot''s Quick-Buy test does not apply. System accounts (flowty_excluded_addresses) and self-trades excluded. Counts buyers, never names them. audit_20261026.';
