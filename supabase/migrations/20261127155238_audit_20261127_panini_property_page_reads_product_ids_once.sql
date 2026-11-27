-- audit_20261127_panini_property_page_reads_product_ids_once
--
-- Every Panini league / brand page (/panini-blockchain/property/<slug>) was rendering "Couldn't load this
-- page" (found 11-27 7:50 AM PT by a rendered sweep of all 25 league pages; HTTP said 200). The page read
-- get_panini_property_page cost ~1,000,000 buffers and 3-6 s for ANY league, even a one-product one: its
-- "top players" step filtered panini_editions with `product_set_id = ANY (panini_property_set_ids(p_slug))`,
-- and that SQL helper inlines into the scan filter and re-runs for each of the 58k rows scanned (932,801 of
-- the buffers). With the Teams / Nations read beside it the page passed its read deadline, and ISR then kept
-- the failed render for its 30-minute window.
-- Fix: the league's product ids are read once into a MATERIALIZED CTE and joined. Same signature, same json
-- (md5 over five leagues compared before and after). The helper itself is unchanged; the API routes call it
-- once per request, which is fine.
--
-- Revert: re-apply get_panini_property_page from 20261126193845.

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
  ), ids AS MATERIALIZED (
    -- the league's product ids, read ONCE (see the header: the array helper inlined into the scan filter)
    SELECT pp.set_id FROM public.panini_products pp WHERE pp.property_slug = p_slug
  ), per AS (
    SELECT btrim(pe.player_name) AS player_name,
           count(*)::int AS editions,
           count(*) FILTER (WHERE f.fmv_usd > 0)::int AS priced_editions,
           round(sum(f.fmv_usd) FILTER (WHERE f.fmv_usd > 0), 2) AS fmv_total_usd
      FROM ids
      JOIN public.panini_editions pe ON pe.product_set_id = ids.set_id
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
-- anon-exec: unchanged (get_panini_property_page) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon=false).
