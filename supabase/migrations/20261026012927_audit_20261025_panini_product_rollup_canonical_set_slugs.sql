-- audit_20261025: Panini product rollup, part 2 — set links use the canonical slug get_set_detail serves.
--
-- Part 1 (20261026012737) linked each set by its product-scoped key; for 24 of 124 sets in three products checked
-- that key 308s to a plain slug (get_set_detail's #204 rule: a set name carried by ONE product other than the
-- World Cup catalog canonicalises to the slugified name). Calling get_set_detail per set costs ~3.5 s / ~960k
-- buffers for 2,707 sets, so the rollup applies the same rule itself. The set's display name is now the editions'
-- set name ("Blue Camo"), not the `sets` row's "<product> · <set>" label. Nothing else changes.
--
-- Revert: re-apply refresh_panini_product_rollup from 20261026012737.

-- anon-exec: unchanged (refresh_panini_product_rollup) — CREATE OR REPLACE of the fn created in 20261026012737; ACL preserved, verified has_function_privilege anon=false.
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
  WITH b AS MATERIALIZED (
    SELECT e.product_set_id, e.external_id, e.player_name, e.set_name, e.parallel, e.mint_cap, e.thumbnail_url,
           mb.fmv_usd, mb.low_ask_usd
      FROM public.panini_editions e
      LEFT JOIN public.panini_market_board mb ON mb.external_id = e.external_id
     WHERE e.product_set_id IS NOT NULL
  ), s90 AS MATERIALIZED (
    SELECT e.product_set_id, e.external_id, e.player_name, e.parallel, s.sku, s.amount_usd, s.sold_at
      FROM public.panini_sales s
      JOIN public.panini_editions e ON e.external_id = s.edition_external_id
     WHERE s.sold_at > now() - interval '90 days'
       AND e.product_set_id IS NOT NULL
  ), s30 AS (
    SELECT product_set_id, count(*)::int AS n, sum(amount_usd) AS vol,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_usd) AS med, max(sold_at) AS newest
      FROM s90 WHERE sold_at > now() - interval '30 days'
     GROUP BY 1
  ), top_s AS (
    SELECT product_set_id,
           jsonb_agg(jsonb_build_object('external_id', external_id, 'player_name', player_name, 'parallel', parallel,
                                        'sku', sku, 'amount_usd', amount_usd, 'sold_at', sold_at)
                     ORDER BY amount_usd DESC, sold_at DESC) AS j
      FROM (SELECT s90.*, row_number() OVER (PARTITION BY product_set_id ORDER BY amount_usd DESC, sold_at DESC) AS rn FROM s90) x
     WHERE rn <= 8
     GROUP BY 1
  ), top_e AS (
    SELECT product_set_id,
           jsonb_agg(jsonb_build_object('external_id', external_id, 'player_name', player_name, 'parallel', parallel,
                                        'set_name', set_name, 'mint_cap', mint_cap, 'thumbnail_url', thumbnail_url,
                                        'fmv_usd', fmv_usd, 'low_ask_usd', low_ask_usd)
                     ORDER BY fmv_usd DESC, external_id) AS j
      FROM (SELECT b.*, row_number() OVER (PARTITION BY product_set_id ORDER BY fmv_usd DESC, external_id) AS rn
              FROM b WHERE fmv_usd IS NOT NULL) x
     WHERE rn <= 12
     GROUP BY 1
  ), sets_g AS (
    -- One row per `sets` row (product-scoped). `slug` is the URL get_set_detail treats as canonical (its #204
    -- rule, 20261025221903): a set name carried by exactly ONE product other than the World Cup catalog (2332)
    -- canonicalises to the plain slugified name; otherwise the product-scoped key (external_id minus 'panini-').
    SELECT b.product_set_id, st.external_id AS set_ext, min(b.set_name) AS set_name,
           count(*)::int AS editions, count(b.low_ask_usd)::int AS listed,
           sum(b.fmv_usd) AS fmv_total, min(b.low_ask_usd) AS cheapest_ask
      FROM b
      JOIN public.editions ed ON ed.external_id = b.external_id
                             AND ed.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      JOIN public.sets st ON st.id = ed.set_id
     GROUP BY 1, 2
  ), sets_c AS (
    SELECT g.*,
           CASE WHEN g.product_set_id <> 2332 AND count(*) OVER (PARTITION BY g.set_name) = 1
                THEN regexp_replace(lower(g.set_name), '[^a-z0-9]+', '-', 'g')
                ELSE substring(g.set_ext FROM 8) END AS set_slug
      FROM sets_g g
  ), sets_j AS (
    SELECT product_set_id, count(*)::int AS n,
           jsonb_agg(jsonb_build_object('slug', set_slug, 'name', set_name, 'editions', editions, 'listed', listed,
                                        'fmv_total_usd', fmv_total, 'cheapest_ask_usd', cheapest_ask)
                     ORDER BY editions DESC, set_slug) AS j
      FROM sets_c GROUP BY 1
  ), agg AS (
    SELECT b.product_set_id,
           count(*)::int AS editions,
           count(DISTINCT b.player_name)::int AS players,
           count(b.fmv_usd)::int AS priced,
           sum(b.fmv_usd) AS fmv_total,
           count(b.low_ask_usd)::int AS listed,
           min(b.low_ask_usd) AS cheapest
      FROM b GROUP BY 1
  )
  INSERT INTO public.panini_product_rollup AS r
    (product_set_id, name, slug, sport, editions, players, sets, priced_editions, fmv_total_usd, listed_editions,
     cheapest_ask_usd, sales_30d, sales_30d_volume_usd, sales_30d_median_usd, newest_sale_at,
     top_editions, top_sales_90d, sets_list, computed_at)
  SELECT p.set_id,
         COALESCE(NULLIF(btrim(p.name), ''), 'Panini product ' || p.set_id),
         p.set_id || '-' || COALESCE(NULLIF(btrim(regexp_replace(lower(COALESCE(NULLIF(btrim(p.name), ''), 'panini product')), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'panini-product'),
         initcap(lower(COALESCE(p.sport, p.last_grid_sport))),
         a.editions, a.players, COALESCE(sj.n, 0), a.priced, a.fmv_total, a.listed, a.cheapest,
         COALESCE(s30.n, 0), s30.vol, s30.med, s30.newest,
         COALESCE(te.j, '[]'::jsonb), COALESCE(ts.j, '[]'::jsonb), COALESCE(sj.j, '[]'::jsonb),
         v_started
    FROM agg a
    JOIN public.panini_products p ON p.set_id = a.product_set_id
    LEFT JOIN s30    ON s30.product_set_id = a.product_set_id
    LEFT JOIN top_e te ON te.product_set_id = a.product_set_id
    LEFT JOIN top_s ts ON ts.product_set_id = a.product_set_id
    LEFT JOIN sets_j sj ON sj.product_set_id = a.product_set_id
  ON CONFLICT (product_set_id) DO UPDATE SET
    name = EXCLUDED.name, slug = EXCLUDED.slug, sport = EXCLUDED.sport, editions = EXCLUDED.editions,
    players = EXCLUDED.players, sets = EXCLUDED.sets, priced_editions = EXCLUDED.priced_editions,
    fmv_total_usd = EXCLUDED.fmv_total_usd, listed_editions = EXCLUDED.listed_editions,
    cheapest_ask_usd = EXCLUDED.cheapest_ask_usd, sales_30d = EXCLUDED.sales_30d,
    sales_30d_volume_usd = EXCLUDED.sales_30d_volume_usd, sales_30d_median_usd = EXCLUDED.sales_30d_median_usd,
    newest_sale_at = EXCLUDED.newest_sale_at, top_editions = EXCLUDED.top_editions,
    top_sales_90d = EXCLUDED.top_sales_90d, sets_list = EXCLUDED.sets_list, computed_at = EXCLUDED.computed_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Supersede without deleting: every row one run writes carries the same computed_at (one statement), and the
  -- reader returns only rows from the newest run — so a product that lost every edition stops resolving.
  SELECT count(*)::int INTO v_gone FROM public.panini_product_rollup WHERE computed_at < v_started;

  PERFORM public.log_pipeline_run('panini-product-rollup', v_started, v_rows, v_rows, v_gone, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'rollup wrote no rows' END,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'stale_rows_kept', v_gone));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-product-rollup', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

