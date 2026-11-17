-- audit_20261026: Disney Pinnacle Hot Floors — the Top Shot Hot Floors board (sweep pressure) for Pinnacle
-- (Disney Pinnacle ↔ Top Shot parity, pass 3, 2026-10-26 ~9:10 PM PT).
--
-- Top Shot detects a sweep on its Quick-Buy proposer; Pinnacle sales (pinnacle_sales) carry no proposer, so a
-- sweep here is the All Day / Panini definition: ONE buyer taking 3+ copies of a PIN (render_id — the pin grain,
-- never pinnacle_editions) with no gap over 60 minutes, over the last p_days (default 7, clamped 1..30).
-- Studio-history rows are excluded (twins, #159/#200), as are self-trades and system accounts
-- (flowty_excluded_addresses). Buyers are COUNTED, never named.
--
-- Measured before shipping (2026-10-26 ~9:05 PM PT): 84 sweeps on 61 pins by 14 collectors, 450 swept sales,
-- $735 in 7 days (mostly $1–2 pins). Read 30 ms / 1.8k buffers (an index range on sold_at) — no snapshot needed,
-- unlike All Day's (whose 5 s cold cost was its per-edition floor lookup; Pinnacle's floor is a catalog column).
-- Floor = pinnacle_catalog.floor_ask (> 0) with floor_ask_updated_at, which the listing sweep writes on EVERY row
-- every pass (a CHECKED stamp — lib/market/ask-freshness.ts); FMV = pinnacle_catalog.fmv_usd (> 0). The board
-- shows no FMV confidence (internal only, 10-18).
-- Anon cannot execute (served by the page's service-role read).
--
-- Revert: DROP FUNCTION public.get_pinnacle_hot_floors(integer);

-- anon-exec: revoked (get_pinnacle_hot_floors) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_pinnacle_hot_floors(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH s AS (
    SELECT ps.render_id AS ed, ps.buyer_address AS buyer, ps.sold_at, ps.sale_price_usd AS price_usd,
           ps.sold_at - lag(ps.sold_at) OVER (PARTITION BY ps.render_id, ps.buyer_address ORDER BY ps.sold_at) AS gap
      FROM public.pinnacle_sales ps
     WHERE ps.sold_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 30))
       AND ps.buyer_address IS NOT NULL
       AND ps.render_id IS NOT NULL
       AND ps.source IS DISTINCT FROM 'pinnacle_studio_history_v1'
       AND COALESCE(ps.seller_address, '') <> ps.buyer_address
       AND NOT EXISTS (SELECT 1 FROM public.flowty_excluded_addresses x WHERE lower(x.address) = lower(ps.buyer_address))
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
    'newest_sale_at', (SELECT max(sold_at) FROM public.pinnacle_sales
                        WHERE sold_at > now() - interval '30 days'
                          AND source IS DISTINCT FROM 'pinnacle_studio_history_v1'),
    'editions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'external_id', t.ed, 'player_name', btrim(pc.character_name), 'set_name', btrim(pc.set_name),
               'tier', btrim(pc.variant), 'circulation_count', pc.total_minted,
               'thumbnail_url', pc.thumbnail_url,
               'sweep_buyers', t.sweep_buyers, 'swept_sales', t.swept_sales, 'swept_spend', round(t.swept_spend, 2),
               'last_swept_at', t.last_swept_at,
               'floor_ask', CASE WHEN pc.floor_ask > 0 THEN pc.floor_ask END,
               'floor_ask_verified_at', CASE WHEN pc.floor_ask > 0 THEN pc.floor_ask_updated_at END,
               'fmv_usd', CASE WHEN pc.fmv_usd > 0 THEN pc.fmv_usd END)
             ORDER BY t.sweep_buyers DESC, t.swept_sales DESC, t.swept_spend DESC NULLS LAST, t.ed)
        FROM top t
        JOIN public.pinnacle_catalog pc ON pc.render_id = t.ed), '[]'::jsonb))
$function$;

REVOKE EXECUTE ON FUNCTION public.get_pinnacle_hot_floors(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_hot_floors(integer) TO postgres, service_role;

COMMENT ON FUNCTION public.get_pinnacle_hot_floors(integer) IS
  'Disney Pinnacle Hot Floors (Top Shot parity, 2026-10-26): pins (render_id) where one buyer took 3+ copies with no gap over 60 min (a sweep), last p_days (default 7, clamped 1..30) of pinnacle_sales (studio history excluded). Pinnacle sales carry no proposer, so Top Shot''s Quick-Buy test does not apply. System accounts and self-trades excluded. Counts buyers, never names them. Floor/FMV from pinnacle_catalog. audit_20261026.';
