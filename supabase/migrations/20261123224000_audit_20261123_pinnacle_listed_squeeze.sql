-- audit_20261123: Disney Pinnacle LISTED-SHARE SQUEEZE — pins ranked by how few of their collector-held copies are
-- listed for sale (2026-11-23, Pinnacle parity pass 3; the Pinnacle leg of /insights/squeeze and
-- /insights/allday-squeeze). Top Shot / All Day squeeze on lock + burn; Pinnacle has neither (is_locked is contract
-- maturity, not a collector lock), so its supply squeeze is the LISTED SHARE.
--
--   collector_held = market_cap_current (grain 'edition', match_key = render_id) minted − burned − issuer-held — the
--                    Atlas supply split the market-cap tiles already use; a pin without a known split is left out.
--   listed         = rows for the pin in pinnacle_live_listings, the catalog floor sweep's last COMPLETE pass (every
--                    listing Disney's Studio GraphQL returned; written only when the sweep reached its last page), so
--                    0 is a census, not a window. Its stamp is returned (`listings_seen_at`) and shown.
--   pct_listed     = listed ÷ collector_held.
-- Only pins the sweep covers (catalog source <> 'flow-chain': chain-filled rows have no studio listings to see) and
-- with ≥ p_min_held collector-held copies (default 25 — below that one listing swings the share by 4+ points).
-- With the pin's floor ask, FMV and its last-30-day sale count, so a 0-listed pin nobody trades reads as such.
-- No FMV confidence (internal only).
--
-- Served by the board's and the public route's service-role read; anon/authenticated cannot execute.
-- Revert: DROP FUNCTION public.get_pinnacle_listed_squeeze(integer, integer);

-- anon-exec: revoked (get_pinnacle_listed_squeeze) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_pinnacle_listed_squeeze(p_min_held integer DEFAULT 25, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH l AS (
    SELECT render_id, count(*)::int AS listed FROM public.pinnacle_live_listings GROUP BY render_id
  ), s AS (
    SELECT render_id, count(*)::int AS sales_30d
      FROM public.pinnacle_sales
     WHERE sold_at >= now() - interval '30 days' AND sale_price_usd > 0 AND render_id IS NOT NULL
     GROUP BY render_id
  ), r AS (
    SELECT pc.render_id, pc.character_name, btrim(pc.set_name) AS set_name, pc.edition_type, pc.variant,
           pc.is_chaser, pc.thumbnail_url,
           m.minted, COALESCE(m.burned, 0) AS burned, COALESCE(m.issuer_held, 0) AS issuer_held, m.collector_held,
           COALESCE(l.listed, 0) AS listed,
           CASE WHEN pc.floor_ask > 0 THEN pc.floor_ask END AS floor_ask_usd,
           CASE WHEN pc.fmv_usd > 0 THEN pc.fmv_usd END AS fmv_usd,
           COALESCE(s.sales_30d, 0) AS sales_30d
      FROM public.pinnacle_catalog pc
      JOIN public.market_cap_current m
        ON m.collection_slug = 'disney_pinnacle' AND m.grain = 'edition' AND m.match_key = pc.render_id
       AND m.editions_supply_known = 1 AND m.collector_held IS NOT NULL
      LEFT JOIN l ON l.render_id = pc.render_id
      LEFT JOIN s ON s.render_id = pc.render_id
     WHERE pc.source IS DISTINCT FROM 'flow-chain'
       AND m.collector_held >= GREATEST(COALESCE(p_min_held, 25), 1)
  )
  SELECT jsonb_build_object(
    'listings_seen_at', (SELECT max(seen_at) FROM public.pinnacle_live_listings),
    'min_held', GREATEST(COALESCE(p_min_held, 25), 1),
    'pins_ranked', (SELECT count(*) FROM r),
    'pins_zero_listed', (SELECT count(*) FROM r WHERE listed = 0),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.pct_listed, x.sales_30d DESC, x.collector_held DESC, x.render_id)
       FROM (SELECT r.*, round(100.0 * r.listed / r.collector_held, 1) AS pct_listed
               FROM r
              ORDER BY (r.listed::numeric / r.collector_held), r.sales_30d DESC, r.collector_held DESC, r.render_id
              LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)) x), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_listed_squeeze(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_listed_squeeze(integer, integer) TO service_role;

COMMENT ON FUNCTION public.get_pinnacle_listed_squeeze(integer, integer) IS
  'Disney Pinnacle listed-share squeeze (2026-11-23): pins with >= p_min_held collector-held copies (market_cap_current supply split) ranked by listed (pinnacle_live_listings, last complete sweep) / collector_held ascending, with floor ask, FMV, 30-day sales and the sweep stamp. Chain-filled catalog rows excluded (the sweep cannot see them).';
