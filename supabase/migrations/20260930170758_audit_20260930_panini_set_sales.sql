-- audit_20260930_panini_set_sales
--
-- Sales for a Panini set page (/panini-blockchain/set/<slug>). The shared set page's
-- "Market Activity" reads `sales`, where Panini has no rows, so it is switched off for Panini
-- (set page: wantsActivity). This reads panini_sales (every sale the walk reads, kept since
-- 2026-09-28) for every edition of the set: the top and most recent sales on record, a 30-day
-- summary, and how many of the set's editions have their sales fully on record
-- (panini_sales_reads.complete_since set), so the page can say how complete the lists are.
-- A set has up to 612 editions (Base Prizms Silver, 2026-09-30): too many to pass from the page
-- as an id list, hence a function. Joined on panini_editions.set_name (idx_panini_editions_set);
-- all 600 Panini set names on the shared `editions` rows match a panini_editions.set_name.
--
-- Read by the set page server-side as service_role only.

CREATE OR REPLACE FUNCTION public.panini_set_sales(p_set_names text[], p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH lim AS (
    SELECT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 25) AS n
  ), eds AS (
    SELECT pe.external_id, pe.player_name, pe.set_name
    FROM panini_editions pe
    WHERE pe.set_name = ANY (p_set_names)
  ), s AS (
    SELECT ps.sku, ps.edition_external_id, ps.sold_at, ps.amount_usd, e.player_name, e.set_name
    FROM panini_sales ps
    JOIN eds e ON e.external_id = ps.edition_external_id
    WHERE ps.amount_usd > 0
  )
  SELECT jsonb_build_object(
    'editions',      (SELECT count(*) FROM eds),
    'editions_read', (SELECT count(*) FROM panini_sales_reads r JOIN eds e ON e.external_id = r.edition_external_id
                      WHERE r.complete_since IS NOT NULL),
    'window_30d',    (SELECT jsonb_build_object(
                        'sales', count(*),
                        'volume_usd', round(coalesce(sum(amount_usd), 0), 2),
                        'median_usd', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_usd::float8)::numeric, 2),
                        'editions_traded', count(DISTINCT edition_external_id))
                      FROM s WHERE sold_at > now() - interval '30 days'),
    'top',    COALESCE((SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.amount_usd DESC, t.sold_at DESC, t.sku)
                        FROM (SELECT * FROM s ORDER BY amount_usd DESC, sold_at DESC, sku LIMIT (SELECT n FROM lim)) t), '[]'::jsonb),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.sold_at DESC, t.sku)
                        FROM (SELECT * FROM s ORDER BY sold_at DESC, sku LIMIT (SELECT n FROM lim)) t), '[]'::jsonb)
  )
$$;

REVOKE ALL ON FUNCTION public.panini_set_sales(text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_set_sales(text[], integer) TO service_role;
