-- audit_20261026_pinnacle_top_accumulators
--
-- Disney Pinnacle ↔ Top Shot parity, pass 2 (Cowork, 2026-10-26 evening PT). The Analytics tab's
-- "Top Buyers" (buyer-side accumulation, get_top_accumulators) is hidden on Pinnacle because that
-- function reads sales_market, which holds no Pinnacle sales (they are in pinnacle_sales) — the
-- route says so and refuses disney_pinnacle rather than render real buyers as "no accumulation".
-- This is the Pinnacle arm it asked for: the SAME output shape over pinnacle_sales, with the pin
-- (render_id) as the "edition". Exclusions: the same system list as get_top_accumulators (which
-- includes Pinnacle's custodian 0xedf9df96c92f4595 — the unresolved-buyer placeholder on
-- pinnacle_sales) plus flowty_excluded_addresses, and self-trades (buyer = seller).
-- Measured 2026-10-26 ~8:00 PM PT over 7 d: see the ledger entry for the row count read back.
--
-- anon-exec: revoked (get_pinnacle_top_accumulators) — new read fn, service_role only like get_top_accumulators; REVOKE below.
--
-- REVERT: drop function public.get_pinnacle_top_accumulators(integer, integer);

CREATE OR REPLACE FUNCTION public.get_pinnacle_top_accumulators(p_days integer DEFAULT 7, p_limit integer DEFAULT 25)
RETURNS TABLE(rank integer, buyer_address text, buy_count bigint, spend_usd numeric, avg_price_usd numeric,
              distinct_editions bigint, top_edition_id text, top_edition_buys bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  WITH win AS (
    SELECT lower(s.buyer_address) AS buyer_address, s.render_id, s.sale_price_usd AS price_usd
      FROM public.pinnacle_sales s
     WHERE s.sold_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 30))
       AND s.buyer_address IS NOT NULL
       AND s.render_id IS NOT NULL
       AND s.sale_price_usd > 0
       AND lower(s.buyer_address) IS DISTINCT FROM lower(s.seller_address)
       AND lower(s.buyer_address) NOT IN (
         '0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510',
         '0x0b2a3299cc857e29','0xe4cf4bdc1751c65d','0x87ca73a41bb50ad5',
         '0x4eb8a10cb9f87357','0xb8ea91944fd51c43','0xead892083b3e2c6c',
         '0x18eb4ee6b3c026d2')
       AND NOT EXISTS (SELECT 1 FROM public.flowty_excluded_addresses x WHERE lower(x.address) = lower(s.buyer_address))
  ),
  agg AS (
    SELECT w.buyer_address,
           COUNT(*)::bigint AS buy_count, ROUND(SUM(w.price_usd), 2) AS spend_usd,
           ROUND(AVG(w.price_usd), 2) AS avg_price_usd,
           COUNT(DISTINCT w.render_id)::bigint AS distinct_editions
      FROM win w GROUP BY w.buyer_address
  ),
  sweep AS (
    SELECT DISTINCT ON (w.buyer_address)
           w.buyer_address, w.render_id AS top_edition_id, COUNT(*)::bigint AS top_edition_buys
      FROM win w GROUP BY w.buyer_address, w.render_id
     ORDER BY w.buyer_address, COUNT(*) DESC, w.render_id
  )
  SELECT ROW_NUMBER() OVER (ORDER BY a.spend_usd DESC, a.buy_count DESC, a.buyer_address)::int AS rank,
         a.buyer_address, a.buy_count, a.spend_usd, a.avg_price_usd,
         a.distinct_editions, sw.top_edition_id, sw.top_edition_buys
    FROM agg a JOIN sweep sw USING (buyer_address)
   ORDER BY a.spend_usd DESC, a.buy_count DESC, a.buyer_address
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 50);
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_pinnacle_top_accumulators(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_top_accumulators(integer, integer) TO postgres, service_role;
