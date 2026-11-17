-- audit_20261018_get_golazos_catalog_deals
--
-- WHY. The concierge's search_catalog_deals read v1 `cached_listings` for every
-- non-Pinnacle collection. For LaLiga Golazos v1 holds only Flowty's book (100
-- rows, 2026-10-18) against ~4.3k open asks in the on-chain index
-- (cached_listings_v2), so "find me Golazos deals" answered from Flowty alone.
-- All Day moves to its existing ghost-aware get_allday_market_editions_v3;
-- Golazos has no edition-market RPC, so this is the small one it needs.
--
-- SOURCE. `golazos_edition_floor_ask` (the edition floor view the concierge's
-- get_edition_listings already trusts) + `fmv_current`, one row per listed
-- edition. A missing FMV is NULL (never 0) and sorts after every priced row.
-- Measured warm 2026-10-18, unfiltered top 8: 24 ms, ~6.5k buffers (496 listed
-- editions).
--
-- ACCESS. service_role only (the concierge's server client).
-- anon-exec: intentional — new function, REVOKED from PUBLIC, anon, authenticated at creation; GRANT service_role (get_golazos_catalog_deals)
--
-- REVERT: DROP FUNCTION public.get_golazos_catalog_deals(text, text, text, numeric, numeric, integer);

CREATE OR REPLACE FUNCTION public.get_golazos_catalog_deals(
  p_player       text    DEFAULT NULL,
  p_tier         text    DEFAULT NULL,
  p_team         text    DEFAULT NULL,
  p_max_price    numeric DEFAULT NULL,
  p_min_discount numeric DEFAULT NULL,
  p_limit        integer DEFAULT 8
)
RETURNS TABLE (
  edition_id    uuid,
  external_id   text,
  player_name   text,
  team_name     text,
  set_name      text,
  tier          text,
  floor_ask     numeric,
  floor_flow_id text,
  fmv_usd       numeric,
  confidence    text,
  discount_pct  numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT *
  FROM (
    SELECT e.id,
           e.external_id::text,
           e.player_name::text,
           e.team_name::text,
           e.set_name::text,
           e.tier::text,
           f.floor_ask,
           f.floor_flow_id::text,
           fc.fmv_usd,
           fc.confidence::text,
           CASE WHEN fc.fmv_usd > 0
                THEN round(((fc.fmv_usd - f.floor_ask) / fc.fmv_usd) * 100, 1)
           END AS discount_pct
    FROM golazos_edition_floor_ask f
    JOIN editions e ON e.id = f.edition_id
    LEFT JOIN LATERAL (
      SELECT c.fmv_usd, c.confidence
      FROM fmv_current c
      WHERE c.edition_id = f.edition_id
      LIMIT 1
    ) fc ON true
    WHERE f.floor_ask > 0
      AND (COALESCE(btrim(p_player), '') = '' OR e.player_name ILIKE '%' || btrim(p_player) || '%')
      AND (COALESCE(btrim(p_tier), '')   = '' OR upper(e.tier::text) = upper(btrim(p_tier)))
      AND (COALESCE(btrim(p_team), '')   = '' OR e.team_name ILIKE '%' || btrim(p_team) || '%')
      AND (p_max_price IS NULL OR p_max_price <= 0 OR f.floor_ask <= p_max_price)
  ) d
  WHERE p_min_discount IS NULL OR p_min_discount <= 0 OR d.discount_pct >= p_min_discount
  ORDER BY d.discount_pct DESC NULLS LAST, d.floor_ask ASC
  LIMIT least(greatest(COALESCE(p_limit, 8), 1), 50);
$$;

REVOKE EXECUTE ON FUNCTION public.get_golazos_catalog_deals(text, text, text, numeric, numeric, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_golazos_catalog_deals(text, text, text, numeric, numeric, integer) TO service_role;
