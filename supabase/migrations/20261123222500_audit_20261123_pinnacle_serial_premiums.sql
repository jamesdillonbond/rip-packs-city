-- audit_20261123: Disney Pinnacle SERIAL PREMIUMS — every #1 and perfect-serial (#N of N) sale with the premium it
-- earned over the same pin's other serials (2026-11-23, Pinnacle parity pass 3; the Pinnacle leg of
-- /insights/serial-premiums, /insights/allday-serial-premiums and the Top Shot first-mint tracker).
--
-- Pinnacle prices only two serial bands (#1 and perfect; Trevor 09-27, lib/pinnacle/serial-fmv.ts), so the board is
-- exactly those sales: all time (the window is thin — 112 #1 sales since 2024-12, 54 in the last year), newest first.
-- Premium = sale price ÷ the median of the SAME pin's other serial sales within ±60 days (#1 and perfect excluded
-- from the comparables), shown only with ≥ 3 comparables — else NULL (no premium claimed), never 1.0×.
-- Render grain (pinnacle_catalog by render_id). Self-trades (seller = buyer) excluded. Buyers are never named.
-- Open Edition pins carry no serial, so they never appear.
--
-- Served by the board's and the public route's service-role read; anon/authenticated cannot execute.
-- Revert: DROP FUNCTION public.get_pinnacle_serial_premiums(integer);

-- anon-exec: revoked (get_pinnacle_serial_premiums) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_pinnacle_serial_premiums(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sp AS (
    SELECT ps.id, ps.render_id, ps.serial_number, ps.sale_price_usd AS price_usd, ps.sold_at,
           pc.character_name, btrim(pc.set_name) AS set_name, pc.edition_type, pc.variant, pc.total_minted,
           CASE WHEN ps.serial_number = 1 THEN 'first' ELSE 'perfect' END AS band
      FROM public.pinnacle_sales ps
      JOIN public.pinnacle_catalog pc ON pc.render_id = ps.render_id
     WHERE ps.sale_price_usd > 0
       AND ps.serial_number IS NOT NULL
       AND (ps.serial_number = 1 OR (pc.total_minted > 1 AND ps.serial_number = pc.total_minted))
       AND COALESCE(ps.seller_address, '') IS DISTINCT FROM COALESCE(ps.buyer_address, '-')
  ), c AS (
    SELECT sp.id,
           count(o.*)::int AS n_comps,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY o.sale_price_usd))::numeric AS comp_median
      FROM sp
      LEFT JOIN LATERAL (
        SELECT o.sale_price_usd
          FROM public.pinnacle_sales o
         WHERE o.render_id = sp.render_id
           AND o.sale_price_usd > 0
           AND o.serial_number IS NOT NULL
           AND o.serial_number <> 1
           AND (sp.total_minted IS NULL OR o.serial_number <> sp.total_minted)
           AND o.sold_at BETWEEN sp.sold_at - interval '60 days' AND sp.sold_at + interval '60 days'
      ) o ON true
     GROUP BY sp.id
  ), r AS (
    SELECT sp.*, c.n_comps,
           CASE WHEN c.n_comps >= 3 THEN round(c.comp_median, 2) END AS comp_median_usd,
           CASE WHEN c.n_comps >= 3 AND c.comp_median > 0 THEN round(sp.price_usd / c.comp_median, 2) END AS multiplier
      FROM sp JOIN c ON c.id = sp.id
  )
  SELECT jsonb_build_object(
    'stats', (SELECT jsonb_agg(jsonb_build_object(
                'band', band, 'sales', n, 'with_comps', nc,
                'median_multiplier', med) ORDER BY band)
                FROM (SELECT band, count(*) n, count(multiplier) nc,
                             round((percentile_cont(0.5) WITHIN GROUP (ORDER BY multiplier))::numeric, 2) med
                        FROM r GROUP BY band) b),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'render_id', render_id, 'name', character_name, 'set_name', set_name,
                'edition_type', edition_type, 'variant', variant, 'total_minted', total_minted,
                'serial_number', serial_number, 'band', band, 'price_usd', price_usd, 'sold_at', sold_at,
                'n_comps', n_comps, 'comp_median_usd', comp_median_usd, 'multiplier', multiplier)
                ORDER BY sold_at DESC, render_id)
              FROM (SELECT * FROM r ORDER BY sold_at DESC, render_id
                     LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)) x), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_serial_premiums(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_serial_premiums(integer) TO service_role;

COMMENT ON FUNCTION public.get_pinnacle_serial_premiums(integer) IS
  'Disney Pinnacle serial premiums (2026-11-23): #1 and perfect-serial (#N of N) sales, newest first, each with the median of the same pin''s other serial sales within ±60 days (>= 3 comparables, else NULL) and the multiplier; plus per-band counts and median multiplier. Render grain; self-trades excluded.';
