-- panini_market_board_for_the_shared_market_tab
--
-- The source for Panini's Market tab (/panini-blockchain/market) once the collection publishes
-- (known-issues #64). /api/market dispatches per collection and has no Panini arm; without one it
-- falls through to `cached_listings`, which holds ZERO Panini rows, and renders a confident
-- "no listings" over a market with ~17k live asks (measured 2026-09-25 ~9:40 PM PT: 17,073
-- is_listed serials, 16,860 of them confirmed in the last 7 days).
--
-- EDITION grain, like All Day and Pinnacle (Trevor's Market = edition / Sniper = serial split):
-- one row per bridged Panini edition with at least one ask CONFIRMED by a walk in the last 7 days
-- — the same freshness bar panini_deal_board uses. The row carries the lowest such ask, how many
-- serials are listed, when the ask was last confirmed, and the edition's current FMV from
-- edition_fmv_current (written by sync_panini_bridge, 20260926041006/041443).
--
-- ⚠ LISTING-GATED BY CONSTRUCTION. Panini publishes no checklist; RPC sees a card only once it has
-- been listed. This board is therefore a floor, not a census — the Market tab renders the
-- panini_coverage_summary disclosure beside it. An edition absent here is "no ask RPC has seen
-- in 7 days", never "no listings".
--
-- security_invoker = on (the view guard); read by the service role only.
--
-- REVERT: DROP VIEW IF EXISTS public.panini_market_board;

CREATE OR REPLACE VIEW public.panini_market_board WITH (security_invoker = on) AS
WITH asks AS (
  SELECT s.edition_external_id,
         min(s.price_usd)      AS low_ask_usd,
         count(*)::int         AS listed_count,
         max(s.captured_at)    AS ask_confirmed_at
    FROM public.panini_card_serials s
   WHERE s.is_listed
     AND s.price_usd > 0
     AND s.captured_at > now() - interval '7 days'
   GROUP BY s.edition_external_id
)
SELECT e.id                  AS edition_id,
       e.external_id,
       e.player_name,
       e.set_name,
       e.tier,
       e.circulation_count,
       e.thumbnail_url,
       pe.parallel_family,
       a.low_ask_usd,
       a.listed_count,
       a.ask_confirmed_at,
       c.fmv_usd,
       c.confidence,
       c.computed_at         AS fmv_computed_at,
       CASE WHEN c.fmv_usd > 0 THEN round((1 - a.low_ask_usd / c.fmv_usd) * 100, 1) END AS discount_pct
  FROM asks a
  JOIN public.panini_editions pe ON pe.external_id = a.edition_external_id
  JOIN public.editions e
    ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
   AND e.external_id   = pe.external_id
  LEFT JOIN public.edition_fmv_current c ON c.edition_id = e.id;

REVOKE ALL ON public.panini_market_board FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_market_board TO service_role;
