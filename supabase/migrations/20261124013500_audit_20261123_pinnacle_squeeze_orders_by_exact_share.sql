-- audit_20261123: Pinnacle listed-share squeeze — rank by the EXACT listed share, not the 0.1 %-rounded one.
-- The inner LIMIT already took the lowest exact shares, but the outer jsonb_agg re-sorted on the ROUNDED pct_listed,
-- so every pin under 0.05 % listed (e.g. Pumbaa, 3 of 6,269 listed → 0.0) tied with the truly-unlisted pins and
-- interleaved with them by 30-day sales. Measured 11-23 ~5:30 PM PT. Only the outer ORDER BY changes; the page
-- prints "<0.1%" for a listed pin that rounds to 0 (lib/insights/pinnacle-board-format.ts fmtListedPct).
-- Base verified: live prosrc md5 437a67199833b4243e30f98d65419355 = the body in 20261123224000.
-- anon-exec: revoked (get_pinnacle_listed_squeeze) — CREATE OR REPLACE keeps the ACL (service_role only).
-- Revert: re-apply the function from 20261123224000.

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
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY (x.listed::numeric / x.collector_held), x.sales_30d DESC, x.collector_held DESC, x.render_id)
       FROM (SELECT r.*, round(100.0 * r.listed / r.collector_held, 1) AS pct_listed
               FROM r
              ORDER BY (r.listed::numeric / r.collector_held), r.sales_30d DESC, r.collector_held DESC, r.render_id
              LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)) x), '[]'::jsonb)
  )
$function$;
