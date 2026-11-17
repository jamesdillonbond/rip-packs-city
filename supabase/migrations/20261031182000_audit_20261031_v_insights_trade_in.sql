-- 2026-10-31 (PT) — the public /insights/trade-in board (Trevor: "continue building out
-- our trade features" → "Top Shot This trade-in tools"). Top Shot's Series 2026-27
-- program (the "Fandom in Series 2026-27" post, 10-20): every $10 of a PLAYER's Moments
-- traded in, counted at Top Shot's own AVERAGE SALE PRICE, earns one Top Shot This pack
-- of that player, no cap. The 10-20 internal finder (get_topshot_trade_in_value) used
-- RPC's last-10 average as a PROXY and was held internal "until Top Shot's own ASP can
-- be read". It can: badge_editions.avg_sale_price IS Top Shot's figure (Atlas
-- `averageSalePriceCents`, 20260904063544; 14,014 of 14,506 Top Shot editions at the
-- 10-31 census, refreshed within 2 days). So this board counts what Top Shot counts.
--
-- One row per Top Shot edition carrying both Top Shot's ASP and a live low ask:
--   moments_per_pack = ceil(10 / asp)  — how many of this edition reach $10 of ASP
--   cost_per_pack    = moments_per_pack × low ask — what buying them costs at the ask
--   asp_to_ask       = asp ÷ low ask — how much more a Moment COUNTS than it COSTS
-- `low_ask` is the lowest listing Top Shot reports; the board says so: one listing at
-- that price is confirmed, the next may cost more. No FMV, no confidence (FMV confidence
-- never reaches a user surface). `asp_at` is when Top Shot's figures were last read.
--
-- Cost (EXPLAIN ANALYZE 2026-10-31, cheapest-50): ~2k buffers, 40 ms; the route caches
-- an hour. security_invoker = on; editions and badge_editions are anon-SELECT with RLS.
-- Revert: DROP VIEW public.v_insights_trade_in; DROP FUNCTION public.get_topshot_trade_in_portfolio(text, int);

CREATE OR REPLACE VIEW public.v_insights_trade_in
WITH (security_invoker = on) AS
SELECT e.id AS edition_id,
       e.external_id::text AS external_id,
       e.player_name,
       e.team_name,
       e.set_name,
       coalesce(e.subedition_name, 'Standard') AS printing,
       e.tier::text AS tier,
       e.series,
       e.circulation_count,
       be.burned,
       CASE WHEN be.burned IS NOT NULL THEN e.circulation_count - be.burned END AS live_supply,
       be.avg_sale_price AS asp,
       be.low_ask,
       ceil(10 / be.avg_sale_price)::int AS moments_per_pack,
       round(ceil(10 / be.avg_sale_price) * be.low_ask, 2) AS cost_per_pack,
       round(be.avg_sale_price / be.low_ask, 2) AS asp_to_ask,
       be.updated_at AS asp_at
  FROM public.editions e
  JOIN public.badge_editions be
    ON be.collection_id = e.collection_id AND be.external_id = e.external_id
 WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
   AND be.avg_sale_price > 0
   AND be.low_ask > 0;

COMMENT ON VIEW public.v_insights_trade_in IS
  'Public /insights/trade-in: per Top Shot edition, Top Shot''s own average sale price (badge_editions.avg_sale_price, what Series 2026-27 Top Shot This trade-ins count at $10 per pack) against its lowest live ask: Moments per pack and cost per pack at the ask. security_invoker; no FMV, no confidence.';

REVOKE ALL ON public.v_insights_trade_in FROM anon, authenticated;
GRANT SELECT ON public.v_insights_trade_in TO anon, authenticated;

-- What a wallet's Top Shot Moments count for, per player: the sum of Top Shot's ASP
-- over the Moments RPC has indexed for it (wallet_moments_cache, Top Shot rows only),
-- whole packs earned and the ASP still needed for the next one. Moments without an
-- ASP are COUNTED separately, never valued at $0. SECURITY INVOKER: the caller's own
-- read of two anon-SELECT tables.
-- ⚠ PostgREST clamps a set-returning RPC at 1,000 rows SILENTLY (a 28k-Moment wallet has
-- 1,332 players): the function takes its own p_limit (default 200, most ASP first) and
-- every row carries total_players, so the page can say "showing 200 of 1,332".
CREATE OR REPLACE FUNCTION public.get_topshot_trade_in_portfolio(p_wallet text, p_limit int DEFAULT 200)
RETURNS TABLE (
  player_name text,
  moments int,
  moments_with_asp int,
  asp_total numeric,
  packs int,
  to_next_pack numeric,
  total_players int
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH rows_ AS (
    SELECT coalesce(w.player_name, be.player_name) AS player_name, be.avg_sale_price AS asp
      FROM public.wallet_moments_cache w
      LEFT JOIN public.badge_editions be
             ON be.collection_id = w.collection_id AND be.external_id = w.edition_key
     WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND w.wallet_address = lower(p_wallet)
  ), per_player AS (
    SELECT r.player_name,
           count(*)::int AS moments,
           count(r.asp)::int AS moments_with_asp,
           coalesce(sum(r.asp), 0) AS asp_sum
      FROM rows_ r
     WHERE r.player_name IS NOT NULL
     GROUP BY r.player_name
  )
  SELECT p.player_name,
         p.moments,
         p.moments_with_asp,
         round(p.asp_sum, 2) AS asp_total,
         floor(p.asp_sum / 10)::int AS packs,
         round(10 - (p.asp_sum - 10 * floor(p.asp_sum / 10)), 2) AS to_next_pack,
         (count(*) OVER ())::int AS total_players
    FROM per_player p
   ORDER BY p.asp_sum DESC, p.player_name
   LIMIT greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

COMMENT ON FUNCTION public.get_topshot_trade_in_portfolio(text, int) IS
  '/insights/trade-in ?wallet= arm: per player (most ASP first, p_limit rows ≤ 1000), the sum of Top Shot''s ASP over a wallet''s indexed Top Shot Moments, whole Top Shot This packs earned ($10 each), the ASP to the next pack, and total_players for the "showing N of M" line. Moments with no ASP are counted, not valued.';

REVOKE ALL ON FUNCTION public.get_topshot_trade_in_portfolio(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_topshot_trade_in_portfolio(text, int) TO anon, authenticated, service_role;
