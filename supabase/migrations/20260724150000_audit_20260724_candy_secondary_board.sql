-- Candy (2026 MLB Base Series ICONs, chain-two/Solana) first public insights board backing view.
-- STAGED pre-launch: gated by proxy.ts (isPublicPath returns false for /insights/candy*) + noindex + not
-- in sitemap/hub. candy_mlb stays is_active=false; this reads Candy directly (does NOT need the is_active
-- flip or the 28-shared-RPC candy-arm fix). security_invoker so it runs with the CALLER's rights; the API
-- reads it via supabaseAdmin (service_role). anon/authenticated SELECT is REVOKED — route-gating is NOT
-- data-gating (2026-07-19 lesson). best_offer_usd is an OFFER-derived signal, a SEPARATE column, NEVER FMV.
-- Applied live via MCP; this file is for repo/rebuild parity (re-applying is harmless).
-- Revert: DROP VIEW public.candy_secondary_board;
CREATE OR REPLACE VIEW public.candy_secondary_board
WITH (security_invoker = true) AS
WITH cand AS (
  SELECT e.id, e.external_id, e.name AS edition_name, e.player_name, e.tier, e.circulation_count
  FROM public.editions e
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
),
sale_stats AS (
  SELECT s.edition_id,
         count(*) AS sales_all,
         count(*) FILTER (WHERE s.sold_at > now() - interval '24 hours') AS sales_24h,
         count(*) FILTER (WHERE s.sold_at > now() - interval '7 days')  AS sales_7d,
         max(s.sold_at) AS last_sale_at,
         (array_agg(s.price_usd ORDER BY s.sold_at DESC))[1] AS last_sale_usd
  FROM public.sales s
  WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND s.edition_id IS NOT NULL
  GROUP BY s.edition_id
)
SELECT
  c.external_id,
  c.player_name,
  c.edition_name,
  c.tier::text                              AS tier,
  (c.tier = 'LEGENDARY')                    AS is_rainbow,
  c.circulation_count,
  fc.fmv_usd,
  fc.confidence::text                       AS confidence,
  fc.computed_at                            AS fmv_computed_at,
  COALESCE(ss.sales_24h, 0)                 AS sales_24h,
  COALESCE(ss.sales_7d, 0)                  AS sales_7d,
  COALESCE(ss.sales_all, 0)                 AS sales_all,
  ss.last_sale_at,
  ss.last_sale_usd,
  bo.best_offer_usd,
  bo.distinct_bidders                       AS offer_bidders
FROM cand c
LEFT JOIN public.fmv_current fc      ON fc.edition_id = c.id
LEFT JOIN sale_stats ss              ON ss.edition_id = c.id
LEFT JOIN public.candy_best_offers bo ON bo.edition_id = c.id;

REVOKE ALL ON public.candy_secondary_board FROM anon, authenticated;
GRANT SELECT ON public.candy_secondary_board TO service_role;
