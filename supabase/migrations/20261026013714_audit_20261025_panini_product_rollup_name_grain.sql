-- audit_20261025: Panini product rollup, part 3 — one page per product NAME, not per Panini set id.
--
-- Panini reuses one product name across several set ids (drops / waves): 106 set ids with editions carry only 67
-- names — "2023-24 Panini NFT Best of The NBA" is 12 ids, "2023-24 Panini NFT Prizm Basketball" 4 (1,341 + 39 +
-- 27 + 23 editions). Per-id pages would have been 12 identically titled pages for one product a collector knows by
-- name. Each name group is now keyed on its lowest set id (no DDL drop needed); `product_set_ids` lists the ids
-- with editions; the slug is the slugified name with no id ("2023-24-panini-nft-prizm-basketball"; an unnamed
-- product stays "panini-product-<id>"). New reader get_panini_product_by_slug(text). Rows keyed on an id that is
-- no longer a group's lowest are left in place and ignored (readers serve only the newest run's rows).
--
-- Verified after the first run (2026-10-25 ~6:40 PM PT): 67 rows, 67 distinct slugs, editions summing to all
-- 39,316 panini_editions; 10.5 s.
--
-- Revert: re-apply refresh_panini_product_rollup from 20261026012927; the added column and
--   get_panini_product_by_slug(text) are inert without the new body (drop them by hand if wanted).

-- anon-exec: unchanged (refresh_panini_product_rollup) — CREATE OR REPLACE of the fn created in 20261026012737; ACL preserved, verified has_function_privilege anon=false.
-- anon-exec: revoked (get_panini_product_by_slug) — new fn, read through the server's service role; REVOKE FROM PUBLIC, anon, authenticated below.
ALTER TABLE public.panini_product_rollup ADD COLUMN IF NOT EXISTS product_set_ids integer[] NOT NULL DEFAULT '{}'::integer[];

CREATE OR REPLACE FUNCTION public.refresh_panini_product_rollup()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
  v_gone    integer;
BEGIN
  WITH pk AS MATERIALIZED (
    -- A Panini product NAME spans several set ids (drops/waves: "2023-24 Panini NFT Best of The NBA" is 12).
    -- The page grain is the name; an unnamed product keeps its own id.
    SELECT p.set_id, COALESCE(NULLIF(btrim(p.name), ''), 'Panini product ' || p.set_id) AS name_key,
           COALESCE(p.sport, p.last_grid_sport) AS sport
      FROM public.panini_products p
  ), grp AS (
    SELECT name_key, min(set_id) AS key_id, array_agg(set_id ORDER BY set_id) AS ids,
           initcap(lower(min(sport))) AS sport
      FROM pk GROUP BY name_key
  ), b AS MATERIALIZED (
    SELECT g.key_id, e.product_set_id, e.external_id, e.player_name, e.set_name, e.parallel, e.mint_cap, e.thumbnail_url,
           mb.fmv_usd, mb.low_ask_usd
      FROM public.panini_editions e
      JOIN pk ON pk.set_id = e.product_set_id
      JOIN grp g ON g.name_key = pk.name_key
      LEFT JOIN public.panini_market_board mb ON mb.external_id = e.external_id
  ), s90 AS MATERIALIZED (
    SELECT b.key_id, b.external_id, b.player_name, b.parallel, s.sku, s.amount_usd, s.sold_at
      FROM public.panini_sales s
      JOIN b ON b.external_id = s.edition_external_id
     WHERE s.sold_at > now() - interval '90 days'
  ), s30 AS (
    SELECT key_id, count(*)::int AS n, sum(amount_usd) AS vol,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_usd) AS med, max(sold_at) AS newest
      FROM s90 WHERE sold_at > now() - interval '30 days'
     GROUP BY 1
  ), top_s AS (
    SELECT key_id,
           jsonb_agg(jsonb_build_object('external_id', external_id, 'player_name', player_name, 'parallel', parallel,
                                        'sku', sku, 'amount_usd', amount_usd, 'sold_at', sold_at)
                     ORDER BY amount_usd DESC, sold_at DESC) AS j
      FROM (SELECT s90.*, row_number() OVER (PARTITION BY key_id ORDER BY amount_usd DESC, sold_at DESC) AS rn FROM s90) x
     WHERE rn <= 8
     GROUP BY 1
  ), top_e AS (
    SELECT key_id,
           jsonb_agg(jsonb_build_object('external_id', external_id, 'player_name', player_name, 'parallel', parallel,
                                        'set_name', set_name, 'mint_cap', mint_cap, 'thumbnail_url', thumbnail_url,
                                        'fmv_usd', fmv_usd, 'low_ask_usd', low_ask_usd)
                     ORDER BY fmv_usd DESC, external_id) AS j
      FROM (SELECT b.*, row_number() OVER (PARTITION BY key_id ORDER BY fmv_usd DESC, external_id) AS rn
              FROM b WHERE fmv_usd IS NOT NULL) x
     WHERE rn <= 12
     GROUP BY 1
  ), sets_g AS (
    -- One row per `sets` row. `slug` is the URL get_set_detail treats as canonical (#204 rule, 20261025221903):
    -- a set name carried by exactly ONE `sets` row outside the World Cup catalog (2332) canonicalises to the
    -- plain slugified name; otherwise the product-scoped key (external_id minus 'panini-').
    SELECT b.key_id, b.product_set_id, st.external_id AS set_ext, min(b.set_name) AS set_name,
           count(*)::int AS editions, count(b.low_ask_usd)::int AS listed,
           sum(b.fmv_usd) AS fmv_total, min(b.low_ask_usd) AS cheapest_ask
      FROM b
      JOIN public.editions ed ON ed.external_id = b.external_id
                             AND ed.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      JOIN public.sets st ON st.id = ed.set_id
     GROUP BY 1, 2, 3
  ), sets_c AS (
    SELECT g.*,
           CASE WHEN g.product_set_id <> 2332 AND count(*) OVER (PARTITION BY g.set_name) = 1
                THEN regexp_replace(lower(g.set_name), '[^a-z0-9]+', '-', 'g')
                ELSE substring(g.set_ext FROM 8) END AS set_slug
      FROM sets_g g
  ), sets_j AS (
    SELECT key_id, count(*)::int AS n,
           jsonb_agg(jsonb_build_object('slug', set_slug, 'name', set_name, 'editions', editions, 'listed', listed,
                                        'fmv_total_usd', fmv_total, 'cheapest_ask_usd', cheapest_ask)
                     ORDER BY editions DESC, set_slug) AS j
      FROM sets_c GROUP BY 1
  ), agg AS (
    SELECT b.key_id,
           count(*)::int AS editions,
           count(DISTINCT b.player_name)::int AS players,
           count(b.fmv_usd)::int AS priced,
           sum(b.fmv_usd) AS fmv_total,
           count(b.low_ask_usd)::int AS listed,
           min(b.low_ask_usd) AS cheapest,
           array_agg(DISTINCT b.product_set_id ORDER BY b.product_set_id) AS ids_with_editions
      FROM b GROUP BY 1
  )
  INSERT INTO public.panini_product_rollup AS r
    (product_set_id, product_set_ids, name, slug, sport, editions, players, sets, priced_editions, fmv_total_usd,
     listed_editions, cheapest_ask_usd, sales_30d, sales_30d_volume_usd, sales_30d_median_usd, newest_sale_at,
     top_editions, top_sales_90d, sets_list, computed_at)
  SELECT g.key_id,
         a.ids_with_editions,
         g.name_key,
         COALESCE(NULLIF(btrim(regexp_replace(lower(g.name_key), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'panini-product-' || g.key_id),
         g.sport,
         a.editions, a.players, COALESCE(sj.n, 0), a.priced, a.fmv_total, a.listed, a.cheapest,
         COALESCE(s30.n, 0), s30.vol, s30.med, s30.newest,
         COALESCE(te.j, '[]'::jsonb), COALESCE(ts.j, '[]'::jsonb), COALESCE(sj.j, '[]'::jsonb),
         v_started
    FROM agg a
    JOIN grp g ON g.key_id = a.key_id
    LEFT JOIN s30    ON s30.key_id = a.key_id
    LEFT JOIN top_e te ON te.key_id = a.key_id
    LEFT JOIN top_s ts ON ts.key_id = a.key_id
    LEFT JOIN sets_j sj ON sj.key_id = a.key_id
  ON CONFLICT (product_set_id) DO UPDATE SET
    product_set_ids = EXCLUDED.product_set_ids,
    name = EXCLUDED.name, slug = EXCLUDED.slug, sport = EXCLUDED.sport, editions = EXCLUDED.editions,
    players = EXCLUDED.players, sets = EXCLUDED.sets, priced_editions = EXCLUDED.priced_editions,
    fmv_total_usd = EXCLUDED.fmv_total_usd, listed_editions = EXCLUDED.listed_editions,
    cheapest_ask_usd = EXCLUDED.cheapest_ask_usd, sales_30d = EXCLUDED.sales_30d,
    sales_30d_volume_usd = EXCLUDED.sales_30d_volume_usd, sales_30d_median_usd = EXCLUDED.sales_30d_median_usd,
    newest_sale_at = EXCLUDED.newest_sale_at, top_editions = EXCLUDED.top_editions,
    top_sales_90d = EXCLUDED.top_sales_90d, sets_list = EXCLUDED.sets_list, computed_at = EXCLUDED.computed_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Supersede without deleting: every row one run writes carries the same computed_at (one statement), and the
  -- readers return only rows from the newest run — so a product (or a set id folded into a name group) stops resolving.
  SELECT count(*)::int INTO v_gone FROM public.panini_product_rollup WHERE computed_at < v_started;

  PERFORM public.log_pipeline_run('panini-product-rollup', v_started, v_rows, v_rows, v_gone, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'rollup wrote no rows' END,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'stale_rows_kept', v_gone, 'grain', 'product_name'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-product-rollup', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_panini_product_by_slug(p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT to_jsonb(r) FROM public.panini_product_rollup r
   WHERE r.slug = p_slug
     AND r.computed_at = (SELECT max(computed_at) FROM public.panini_product_rollup)
   LIMIT 1
$function$;

REVOKE EXECUTE ON FUNCTION public.get_panini_product_by_slug(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_product_by_slug(text) TO postgres, service_role;

COMMENT ON TABLE public.panini_product_rollup IS
  'One row per Panini product NAME (keyed on its lowest panini_products.set_id; product_set_ids = the ids with editions) for /panini-blockchain/product/<name-slug>. Listing-gated counts (editions SEEN); sales ON RECORD (lagged). Only rows from the newest run (computed_at = max) are current. Rebuilt hourly by refresh_panini_product_rollup(). audit_20261025.';
