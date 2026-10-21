-- audit_20261020_topshot_trade_in_value
-- anon-exec: NOT intentional for get_topshot_trade_in_value — internal read (Cowork dashboard, service role); EXECUTE granted to service_role only.
--
-- Series 2026-27 makes trade-ins a currency (Top Shot blog, "Fandom in Series 2026-27", updated
-- 2026-10-20): every $10 of a player's Moments traded in, by AVERAGE SALE PRICE, earns one pack of that
-- player's Top Shot This; no cap. Top Shot's ASP is the average of an edition's last 10 marketplace
-- transactions (support.nbatopshot.com, "Top Shot Score"). So a Moment's trade-in worth is its ASP,
-- while what it costs to acquire is the live ask — and the two diverge. Measured 2026-10-20 on 92
-- priced LeBron James editions: 10 had a last-10 average >= 1.5x the current ask, 4 >= 2x; median 0.87x.
--
-- get_topshot_trade_in_value(player): per canonical Top Shot edition of that player
--   asp_proxy        average of OUR last 10 recorded sales (price > 0) — a PROXY for Top Shot's ASP:
--                    Top Shot computes its own, may count transactions we do not hold, and both include
--                    premium-serial sales; sales_counted says how many went in (< 10 = thin)
--   live_ask         public.edition_live_ask (the estate's rule: edition_offers seen <= 7 d, else
--                    badge_editions <= 7 d; only when <= 3x FMV) — NULL = no live ask, never 0
--   asp_to_ask       asp_proxy / live_ask
--   moments_per_pack ceil(10 / asp_proxy) — Moments of this edition to trade in for one pack
--   cost_per_pack    moments_per_pack x live_ask — assumes that many copies at the ask; only ONE
--                    listing at that price is confirmed, so it is a floor on the real cost
--   live_supply      minted - Atlas burned (NULL when burns are unreported)
-- Internal only: not a public number until Top Shot's ASP itself can be read.
-- ⚠ Superseded the same evening by 20261021005900 (adds median_last10 / outlier_driven); this
-- first version was renamed aside there.
--
-- REVERT: DROP FUNCTION public.get_topshot_trade_in_value(text);

CREATE FUNCTION public.get_topshot_trade_in_value(p_player_name text)
RETURNS TABLE(
  edition_external_id text,
  set_name            text,
  series              smallint,
  printing            text,
  tier                text,
  live_supply         integer,
  sales_counted       integer,
  asp_proxy           numeric,
  last_sale_at        timestamptz,
  live_ask            numeric,
  ask_source          text,
  asp_to_ask          numeric,
  moments_per_pack    integer,
  cost_per_pack       numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH eds AS (
    SELECT e.id, e.external_id::text AS ext, e.set_name, e.series,
           coalesce(e.subedition_name, 'Standard') AS printing, e.tier::text AS tier,
           CASE WHEN be.burned IS NOT NULL THEN e.circulation_count - be.burned END AS live
      FROM public.editions e
      LEFT JOIN public.badge_editions be
             ON be.collection_id = e.collection_id AND be.external_id = e.external_id
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND e.player_name = p_player_name
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       AND coalesce(e.circulation_count, 0) > 0
  ), priced AS (
    SELECT eds.*, s.n, s.avg_price, s.last_at, a.ask, a.source
      FROM eds
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n, round(avg(x.price_usd), 2) AS avg_price, max(x.sold_at) AS last_at
          FROM (SELECT sa.price_usd, sa.sold_at
                  FROM public.sales sa
                 WHERE sa.edition_id = eds.id AND sa.price_usd > 0
                 ORDER BY sa.sold_at DESC
                 LIMIT 10) x
      ) s
      LEFT JOIN LATERAL public.edition_live_ask('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, eds.ext) a ON true
  )
  SELECT p.ext, p.set_name, p.series, p.printing, p.tier, p.live,
         p.n, CASE WHEN p.n > 0 THEN p.avg_price END, p.last_at,
         p.ask, p.source,
         CASE WHEN p.n > 0 AND p.ask > 0 THEN round(p.avg_price / p.ask, 2) END,
         CASE WHEN p.n > 0 AND p.avg_price > 0 THEN ceil(10 / p.avg_price)::int END,
         CASE WHEN p.n > 0 AND p.avg_price > 0 AND p.ask > 0 THEN round(ceil(10 / p.avg_price) * p.ask, 2) END
    FROM priced p
   ORDER BY CASE WHEN p.n > 0 AND p.ask > 0 THEN p.avg_price / p.ask END DESC NULLS LAST, p.ext;
$function$;

COMMENT ON FUNCTION public.get_topshot_trade_in_value(text) IS
  'Trade-in worth vs cost to buy for one Top Shot player''s editions (Series 2026-27 Top Shot This: $10 of ASP = 1 pack). asp_proxy = average of RPC''s last 10 recorded sales (a proxy for Top Shot''s ASP); live_ask = edition_live_ask (NULL = none); cost_per_pack assumes enough copies at the ask. Internal only. audit_20261020.';

REVOKE ALL ON FUNCTION public.get_topshot_trade_in_value(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_trade_in_value(text) TO service_role;
