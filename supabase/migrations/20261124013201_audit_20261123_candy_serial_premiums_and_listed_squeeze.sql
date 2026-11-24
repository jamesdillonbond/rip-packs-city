-- audit_20261123: Candy SERIAL PREMIUMS + LISTED-SHARE SQUEEZE (2026-11-23 evening, Candy parity pass 1; the Candy
-- legs of /insights/serial-premiums and /insights/squeeze, built the way Disney Pinnacle's were that afternoon:
-- 20261123222500 get_pinnacle_serial_premiums, 20261123224000 get_pinnacle_listed_squeeze).
--
-- 1. get_candy_serial_premiums(p_limit) — every #1, jersey-match and perfect (#N of N) Candy sale with the premium it
--    earned over the SAME edition's other serials within ±60 days (the three special-serial bands Candy already shows on
--    edition pages and the Serials tab of /insights/candy-mlb). Premium shown only with ≥ 3 comparables, else NULL
--    (no premium claimed), never 1.0×. One-of-one editions (circulation_count = 1, the per-mint generative sets) are
--    excluded: their #1 is the only copy, not a special serial. Self-trades (seller = buyer) excluded; buyers never named.
--    Measured before writing (all Candy sales on record, 11-23 ~6 PM PT): first 191 sales / 86 with comparables / median
--    7.33× · jersey 100 / 70 / 2.89× · perfect 114 / 73 / 1.65×.
--
-- 2. get_candy_listed_squeeze(p_min_held, p_limit) — Candy has no locks or burns, so (like Pinnacle) its supply squeeze
--    is the LISTED SHARE: confirmed Magic Eden listings (candy_listing_floor.confirmed_listing_count — re-seen within
--    12 h, troll asks excluded) ÷ collector-held copies (market_cap_current grain 'edition', the supply split the market
--    cap tiles already use; known for the 2026 Base Series ICONs only). Editions with ≥ p_min_held (default 25)
--    collector-held copies. With floor ask, FMV and last-30-day sales so a 0-listed edition nobody trades reads as such.
--    Measured: 100 editions ranked, 66 with 0 listed. No FMV confidence (internal only).
--
-- Both are served by the boards' and public routes' service-role reads; anon/authenticated cannot execute.
-- Revert: DROP FUNCTION public.get_candy_serial_premiums(integer); DROP FUNCTION public.get_candy_listed_squeeze(integer, integer);

-- anon-exec: revoked (get_candy_serial_premiums) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_candy_serial_premiums(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH base AS MATERIALIZED (
    SELECT s.id, s.edition_id, s.serial_number, s.price_usd, s.sold_at,
           e.external_id, e.player_name, e.set_name, e.tier, e.jersey_number, e.circulation_count
      FROM public.sales s
      JOIN public.editions e ON e.id = s.edition_id
     WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND s.price_usd > 0
       AND s.serial_number IS NOT NULL
       AND COALESCE(e.circulation_count, 0) <> 1
       AND COALESCE(s.seller_address, '') IS DISTINCT FROM COALESCE(s.buyer_address, '-')
  ), sp AS (
    SELECT b.*,
           CASE WHEN b.serial_number = 1 THEN 'first'
                WHEN b.circulation_count > 1 AND b.serial_number = b.circulation_count THEN 'perfect'
                WHEN b.jersey_number IS NOT NULL AND b.serial_number = b.jersey_number THEN 'jersey' END AS band
      FROM base b
  ), c AS (
    SELECT sp.id, count(o.price_usd)::int AS n_comps,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY o.price_usd))::numeric AS comp_median
      FROM sp
      LEFT JOIN LATERAL (
        SELECT o.price_usd
          FROM base o
         WHERE o.edition_id = sp.edition_id
           AND o.serial_number <> 1
           AND o.serial_number IS DISTINCT FROM sp.circulation_count
           AND o.serial_number IS DISTINCT FROM sp.jersey_number
           AND o.sold_at BETWEEN sp.sold_at - interval '60 days' AND sp.sold_at + interval '60 days'
      ) o ON true
     WHERE sp.band IS NOT NULL
     GROUP BY sp.id
  ), r AS (
    SELECT sp.*, c.n_comps,
           CASE WHEN c.n_comps >= 3 THEN round(c.comp_median, 2) END AS comp_median_usd,
           CASE WHEN c.n_comps >= 3 AND c.comp_median > 0 THEN round(sp.price_usd / c.comp_median, 2) END AS multiplier
      FROM sp JOIN c ON c.id = sp.id
  )
  SELECT jsonb_build_object(
    'stats', (SELECT jsonb_agg(jsonb_build_object(
                'band', band, 'sales', n, 'with_comps', nc, 'median_multiplier', med) ORDER BY band)
                FROM (SELECT band, count(*) n, count(multiplier) nc,
                             round((percentile_cont(0.5) WITHIN GROUP (ORDER BY multiplier))::numeric, 2) med
                        FROM r GROUP BY band) b),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'external_id', external_id, 'name', player_name, 'set_name', set_name, 'tier', tier,
                'circulation_count', circulation_count, 'serial_number', serial_number, 'band', band,
                'price_usd', price_usd, 'sold_at', sold_at,
                'n_comps', n_comps, 'comp_median_usd', comp_median_usd, 'multiplier', multiplier)
                ORDER BY sold_at DESC, external_id)
              FROM (SELECT * FROM r ORDER BY sold_at DESC, external_id
                     LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)) x), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.get_candy_serial_premiums(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_candy_serial_premiums(integer) TO service_role;

COMMENT ON FUNCTION public.get_candy_serial_premiums(integer) IS
  'Candy serial premiums (2026-11-23): #1, jersey-match and perfect-serial sales, newest first, each with the median of the same edition''s other serial sales within ±60 days (>= 3 comparables, else NULL) and the multiplier; plus per-band counts and median multiplier. One-of-one editions and self-trades excluded.';

-- anon-exec: revoked (get_candy_listed_squeeze) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_candy_listed_squeeze(p_min_held integer DEFAULT 25, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH s AS (
    SELECT edition_id, count(*)::int AS sales_30d
      FROM public.sales
     WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND sold_at >= now() - interval '30 days' AND price_usd > 0
     GROUP BY edition_id
  ), r AS (
    SELECT e.external_id, e.player_name, e.set_name, e.tier, e.thumbnail_url,
           m.minted, COALESCE(m.burned, 0) AS burned, COALESCE(m.issuer_held, 0) AS issuer_held, m.collector_held,
           COALESCE(f.confirmed_listing_count, 0)::int AS listed,
           CASE WHEN f.confirmed_floor_usd > 0 THEN f.confirmed_floor_usd END AS floor_ask_usd,
           CASE WHEN fc.fmv_usd > 0 THEN fc.fmv_usd END AS fmv_usd,
           COALESCE(s.sales_30d, 0) AS sales_30d
      FROM public.market_cap_current m
      JOIN public.editions e
        ON e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND e.external_id = m.match_key
      LEFT JOIN public.candy_listing_floor f ON f.edition_id = e.id
      LEFT JOIN public.candy_fmv_current fc ON fc.edition_id = e.id
      LEFT JOIN s ON s.edition_id = e.id
     WHERE m.collection_slug = 'candy_mlb' AND m.grain = 'edition'
       AND m.collector_held IS NOT NULL
       AND m.collector_held >= GREATEST(COALESCE(p_min_held, 25), 1)
  )
  SELECT jsonb_build_object(
    'listings_seen_at', (SELECT max(last_seen_at) FROM public.candy_listings WHERE is_active),
    'min_held', GREATEST(COALESCE(p_min_held, 25), 1),
    'editions_ranked', (SELECT count(*) FROM r),
    'editions_zero_listed', (SELECT count(*) FROM r WHERE listed = 0),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.pct_listed, x.sales_30d DESC, x.collector_held DESC, x.external_id)
       FROM (SELECT r.*, round(100.0 * r.listed / r.collector_held, 1) AS pct_listed
               FROM r
              ORDER BY (r.listed::numeric / r.collector_held), r.sales_30d DESC, r.collector_held DESC, r.external_id
              LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)) x), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.get_candy_listed_squeeze(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_candy_listed_squeeze(integer, integer) TO service_role;

COMMENT ON FUNCTION public.get_candy_listed_squeeze(integer, integer) IS
  'Candy listed-share squeeze (2026-11-23): editions with >= p_min_held collector-held copies (market_cap_current supply split; 2026 Base Series ICONs) ranked by confirmed Magic Eden listings (candy_listing_floor, re-seen within 12 h) / collector_held ascending, with floor ask, FMV, 30-day sales and the newest sweep stamp.';
