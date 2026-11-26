-- audit_20261126_panini_property_pages (2026-11-26, Trevor: "Do it all")
--
-- The read behind /panini-blockchain/property/<slug> — one page per league / brand a Panini product is made
-- under (taxonomy: 20261126185023). On screen the word "property" never appears.
--
-- 1. panini_property_set_ids(slug) — the Panini set ids placed under a property ('{}' for none). The scope
--    helper the tab filters reuse.
-- 2. get_panini_property_page(slug, limit) — the property row, totals and product list from the newest
--    panini_product_rollup run, the most valuable editions and biggest 90-day sales merged from each product's
--    own rollup lists (no new scan), and the top subjects by FMV total (the product page's Top Players read,
--    over every set id of the property). NULL = no such property. A property with no product page returns
--    products = [] (the page 404s: a league shows only once it has cards).
--
-- Measured before writing (11-26 ~11:40 AM PT): the subject read for the largest property (NBA, 70 set ids,
-- 14,341 editions) = 119k buffers, 0.38 s; read once per 30-minute ISR window.
--
-- anon-exec: revoked below for both functions (new functions; service-role reads only).
-- REVERT: DROP FUNCTION public.get_panini_property_page(text, integer); DROP FUNCTION public.panini_property_set_ids(text);

CREATE OR REPLACE FUNCTION public.panini_property_set_ids(p_slug text)
RETURNS integer[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(array_agg(set_id ORDER BY set_id), '{}'::integer[])
    FROM public.panini_products
   WHERE property_slug = p_slug
$fn$;
REVOKE EXECUTE ON FUNCTION public.panini_property_set_ids(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_property_set_ids(text) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.get_panini_property_page(p_slug text, p_limit integer DEFAULT 12)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH prop AS (
    SELECT * FROM public.publisher_properties WHERE publisher = 'panini' AND slug = p_slug
  ), lim AS (
    SELECT LEAST(GREATEST(COALESCE(p_limit, 12), 1), 50) AS n
  ), run AS (
    SELECT r.slug, r.name, r.sport, r.editions, r.players, r.sets, r.priced_editions, r.fmv_total_usd,
           r.listed_editions, r.cheapest_ask_usd, r.sales_30d, r.sales_30d_volume_usd, r.newest_sale_at,
           r.top_editions, r.top_sales_90d, r.computed_at,
           substring(r.name from '^\d{4}(?:-\d{2})?') AS season
      FROM public.panini_product_rollup r
      JOIN public.panini_products pp ON pp.set_id = r.product_set_id AND pp.property_slug = p_slug
     WHERE r.computed_at = (SELECT max(computed_at) FROM public.panini_product_rollup)
  ), ids AS (
    SELECT public.panini_property_set_ids(p_slug) AS a
  ), per AS (
    SELECT btrim(pe.player_name) AS player_name,
           count(*)::int AS editions,
           count(*) FILTER (WHERE f.fmv_usd > 0)::int AS priced_editions,
           round(sum(f.fmv_usd) FILTER (WHERE f.fmv_usd > 0), 2) AS fmv_total_usd
      FROM ids
      JOIN public.panini_editions pe ON pe.product_set_id = ANY (ids.a)
      JOIN public.editions e
        ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
       AND e.external_id = pe.external_id
      LEFT JOIN public.edition_fmv_current f ON f.edition_id = e.id
     WHERE nullif(btrim(pe.player_name), '') IS NOT NULL
     GROUP BY 1
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM prop) THEN NULL ELSE jsonb_build_object(
    'property', (SELECT jsonb_build_object('slug', slug, 'name', name, 'heading', heading, 'category', category,
                        'subject_word', subject_word, 'group_word', group_word, 'team_league', team_league) FROM prop),
    'computed_at', (SELECT max(computed_at) FROM run),
    'totals', (SELECT jsonb_build_object(
                 'products', count(*)::int, 'editions', COALESCE(sum(editions), 0)::int,
                 'priced_editions', COALESCE(sum(priced_editions), 0)::int, 'fmv_total_usd', sum(fmv_total_usd),
                 'listed_editions', COALESCE(sum(listed_editions), 0)::int, 'cheapest_ask_usd', min(cheapest_ask_usd),
                 'sales_30d', COALESCE(sum(sales_30d), 0)::int, 'sales_30d_volume_usd', sum(sales_30d_volume_usd),
                 'newest_sale_at', max(newest_sale_at),
                 'first_season', min(season), 'last_season', max(season)) FROM run),
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'slug', slug, 'name', name, 'season', season, 'editions', editions, 'sets', sets,
               'fmv_total_usd', fmv_total_usd, 'listed_editions', listed_editions,
               'sales_30d', sales_30d, 'sales_30d_volume_usd', sales_30d_volume_usd)
             ORDER BY season DESC NULLS LAST, editions DESC, name)
        FROM run), '[]'::jsonb),
    'top_editions', COALESCE((
      SELECT jsonb_agg(x.e ORDER BY x.fmv DESC NULLS LAST)
        FROM (SELECT e, nullif(e->>'fmv_usd', '')::numeric AS fmv
                FROM run, jsonb_array_elements(CASE WHEN jsonb_typeof(run.top_editions) = 'array' THEN run.top_editions ELSE '[]'::jsonb END) AS e
               ORDER BY nullif(e->>'fmv_usd', '')::numeric DESC NULLS LAST
               LIMIT (SELECT n FROM lim)) x), '[]'::jsonb),
    'top_sales_90d', COALESCE((
      SELECT jsonb_agg(x.s ORDER BY x.amt DESC NULLS LAST)
        FROM (SELECT s, nullif(s->>'amount_usd', '')::numeric AS amt
                FROM run, jsonb_array_elements(CASE WHEN jsonb_typeof(run.top_sales_90d) = 'array' THEN run.top_sales_90d ELSE '[]'::jsonb END) AS s
               ORDER BY nullif(s->>'amount_usd', '')::numeric DESC NULLS LAST
               LIMIT (SELECT n FROM lim)) x), '[]'::jsonb),
    'top_subjects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'player_name', x.player_name, 'editions', x.editions,
               'priced_editions', x.priced_editions, 'fmv_total_usd', x.fmv_total_usd)
             ORDER BY x.fmv_total_usd DESC NULLS LAST, x.editions DESC, x.player_name)
        FROM (SELECT * FROM per ORDER BY fmv_total_usd DESC NULLS LAST, editions DESC, player_name
               LIMIT (SELECT n FROM lim)) x), '[]'::jsonb)
  ) END
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_panini_property_page(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_property_page(text, integer) TO postgres, service_role;
