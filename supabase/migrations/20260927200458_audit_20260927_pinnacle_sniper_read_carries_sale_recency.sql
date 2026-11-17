-- audit_20260927_pinnacle_sniper_read_carries_sale_recency
--
-- The shared Sniper guards every other collection's FMV at deal-build time
-- (lib/sniper/fmv-staleness.ts: applyFmvStalenessPenalty needs days-since-sale
-- and 30-day sale count; fmvCannotAnchorDiscount needs confidence). The
-- Pinnacle read added this morning (20260927175154) did not return the first
-- two, so Pinnacle deals skipped the haircut. Adds fmv_days_since_sale and
-- fmv_sales_count_30d from pinnacle_catalog; nothing else changes.
--
-- RETURNS TABLE changes, so DROP + CREATE (the function is new today, has one
-- caller — lib/sniper/pinnacle.ts — and no pin).
--
-- Revert: re-apply the function block from 20260927175154.

DROP FUNCTION IF EXISTS public.get_pinnacle_live_listings_for_sniper(integer);

CREATE FUNCTION public.get_pinnacle_live_listings_for_sniper(p_limit integer DEFAULT 2000)
RETURNS TABLE (
  nft_id text,
  render_id text,
  serial_number integer,
  price_usd numeric,
  seen_at timestamptz,
  character_name text,
  set_name text,
  series_name text,
  variant text,
  total_minted integer,
  edition_type text,
  is_chaser boolean,
  legacy_edition_key text,
  franchises text[],
  fmv_usd numeric,
  fmv_confidence text,
  fmv_days_since_sale integer,
  fmv_sales_count_30d integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT l.nft_id, l.render_id, l.serial_number, l.price_usd, l.seen_at,
         c.character_name, btrim(c.set_name), c.series_name, c.variant, c.total_minted,
         c.edition_type, c.is_chaser, c.legacy_edition_key, c.franchises,
         c.fmv_usd, c.fmv_confidence::text, c.fmv_days_since_sale, c.fmv_sales_count_30d
  FROM public.pinnacle_live_listings l
  JOIN public.pinnacle_catalog c ON c.render_id = l.render_id
  WHERE c.fmv_usd > 0
    AND l.price_usd < c.fmv_usd * 1.03
  ORDER BY (c.fmv_usd - l.price_usd) / c.fmv_usd DESC, l.nft_id
  LIMIT greatest(1, least(coalesce(p_limit, 2000), 5000));
$fn$;

-- anon-exec: revoked (get_pinnacle_live_listings_for_sniper) — recreated by DROP + CREATE, so the ACL is re-stated: service_role only.
REVOKE EXECUTE ON FUNCTION public.get_pinnacle_live_listings_for_sniper(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_live_listings_for_sniper(integer) TO service_role;
