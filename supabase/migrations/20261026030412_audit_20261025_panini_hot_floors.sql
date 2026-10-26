-- audit_20261025: Panini Hot Floors — the Top Shot Hot Floors board (sweep pressure) for Panini (parity pass, 2026-10-25 evening PT).
--
-- Top Shot detects a sweep on its Quick-Buy path; Panini has no bulk buy, so a sweep here is ONE buyer taking 3+ copies
-- of an edition with no gap over 60 minutes, on sales ON RECORD in the last p_days (default 7 — Panini sales reach RPC
-- 12–160 h after they happen, so Top Shot's 3-day window would read mostly empty). Buyers are COUNTED, never named
-- (the Panini counts-only rule, 10-21); self-trades (seller = buyer) are excluded. Read 2026-10-25 ~8:10 PM PT: 50 of
-- the top editions returned, ~166 ms / ~4k buffers. Anon cannot execute (served by the page's service-role read).
--
-- Revert: DROP FUNCTION public.get_panini_hot_floors(integer);

-- anon-exec: revoked (get_panini_hot_floors) — new fn; REVOKE FROM PUBLIC, anon, authenticated below, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.get_panini_hot_floors(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH s AS (
    SELECT edition_external_id AS ed, buyer, sold_at, amount_usd,
           sold_at - lag(sold_at) OVER (PARTITION BY edition_external_id, buyer ORDER BY sold_at) AS gap
      FROM public.panini_sales
     WHERE sold_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 30))
       AND COALESCE(buyer, '') <> ''
       AND COALESCE(seller, '') <> buyer
  ), sess AS (
    SELECT ed, buyer, sold_at, amount_usd,
           sum(CASE WHEN gap IS NULL OR gap > interval '60 minutes' THEN 1 ELSE 0 END)
             OVER (PARTITION BY ed, buyer ORDER BY sold_at) AS sid
      FROM s
  ), g AS (
    SELECT ed, buyer, sid, count(*) AS n, sum(amount_usd) AS spend, max(sold_at) AS t1
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
    'newest_sale_at', (SELECT max(sold_at) FROM public.panini_sales),
    'editions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'external_id', t.ed, 'player_name', pe.player_name, 'set_name', pe.set_name,
               'parallel', pe.parallel, 'mint_cap', pe.mint_cap, 'tier', pe.tier,
               'thumbnail_url', pe.thumbnail_url,
               'sweep_buyers', t.sweep_buyers, 'swept_sales', t.swept_sales, 'swept_spend', t.swept_spend,
               'last_swept_at', t.last_swept_at, 'floor_ask', mb.low_ask_usd, 'fmv_usd', mb.fmv_usd)
             ORDER BY t.sweep_buyers DESC, t.swept_sales DESC, t.swept_spend DESC NULLS LAST, t.ed)
        FROM top t
        JOIN public.panini_editions pe ON pe.external_id = t.ed
        LEFT JOIN LATERAL (SELECT m.low_ask_usd, m.fmv_usd FROM public.panini_market_board m
                            WHERE m.external_id = t.ed LIMIT 1) mb ON true), '[]'::jsonb))
$function$;

REVOKE EXECUTE ON FUNCTION public.get_panini_hot_floors(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_hot_floors(integer) TO postgres, service_role;

COMMENT ON FUNCTION public.get_panini_hot_floors(integer) IS
  'Panini Hot Floors (Top Shot parity, 2026-10-25): editions where one buyer took 3+ copies with no gap over 60 min (a sweep), last p_days (default 7, clamped 1..30) of sales ON RECORD. Counts buyers, never names them. Self-trades (seller = buyer) excluded. audit_20261025.';
