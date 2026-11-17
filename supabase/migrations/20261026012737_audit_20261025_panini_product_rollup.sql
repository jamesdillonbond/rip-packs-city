-- audit_20261025: Panini PRODUCT pages — the Panini counterpart of Top Shot's series pages
-- (Panini ↔ Top Shot parity pass, Cowork cloud, 2026-10-25 evening PT).
--
-- A Panini product ("2026 Panini NFT Prizm World Cup Soccer", "2022-23 … Prizm Basketball") is the grain a
-- collector browses by, as Top Shot's Series is; Panini editions carry no `editions.series` (39,316 of 39,316
-- NULL), so the shared series route cannot serve it. The live per-edition board (panini_market_board) costs
-- ~3.3 s for ONE product because it builds the whole catalogue, so a page read cannot use it. This table holds
-- one row per product, rebuilt hourly in one pass (~5 s for all 106 products, ~670k buffers, all hits,
-- measured 2026-10-25 ~6:40 PM PT).
--
-- What each figure means (and does not):
--   · editions / players / sets       — editions RPC has SEEN (Panini publishes no checklist: listing-gated).
--   · fmv_total_usd / priced_editions — sum of the edition FMVs the market board shows; unpriced editions apart.
--   · listed_editions / cheapest_ask  — editions with an ask re-read in the last 7 days (the board's rule).
--   · sales_30d_*                      — sales ON RECORD with sold_at in the last 30 days. Panini sales reach
--                                       RPC 12–160 h after sold_at, so the newest days are never complete;
--                                       the page says so. NULL-free counts: 0 means none on record.
--   · top_editions / top_sales_90d / sets_list — capped jsonb lists for the page.
--
-- Writes are one INSERT … ON CONFLICT DO UPDATE per run, so a failed run leaves the previous rollup in place. No row is
-- deleted: the reader serves only rows from the newest run (computed_at = max), which retires a vanished product.
--
-- Revert: SELECT cron.unschedule('panini-product-rollup');
--         DROP FUNCTION public.get_panini_product(integer); DROP FUNCTION public.refresh_panini_product_rollup();
--         DROP TABLE public.panini_product_rollup;

CREATE TABLE IF NOT EXISTS public.panini_product_rollup (
  product_set_id        integer PRIMARY KEY,
  name                  text        NOT NULL,
  slug                  text        NOT NULL,
  sport                 text,
  editions              integer     NOT NULL,
  players               integer     NOT NULL,
  sets                  integer     NOT NULL,
  priced_editions       integer     NOT NULL,
  fmv_total_usd         numeric,
  listed_editions       integer     NOT NULL,
  cheapest_ask_usd      numeric,
  sales_30d             integer     NOT NULL,
  sales_30d_volume_usd  numeric,
  sales_30d_median_usd  numeric,
  newest_sale_at        timestamptz,
  top_editions          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_sales_90d         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sets_list             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  computed_at           timestamptz NOT NULL
);

ALTER TABLE public.panini_product_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_product_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_product_rollup TO service_role;

COMMENT ON TABLE public.panini_product_rollup IS
  'One row per Panini product (panini_products.set_id) for /panini-blockchain/product/<id>-<slug>. Listing-gated counts (editions SEEN); sales are ON RECORD (lagged). Rebuilt hourly by refresh_panini_product_rollup(). audit_20261025.';

-- anon-exec: revoked (refresh_panini_product_rollup) — new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated below.
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
    SELECT b.product_set_id, substring(st.external_id FROM 8) AS set_slug, st.name AS set_name,
           count(*)::int AS editions, count(b.low_ask_usd)::int AS listed,
           sum(b.fmv_usd) AS fmv_total, min(b.low_ask_usd) AS cheapest_ask
      FROM b
      JOIN public.editions ed ON ed.external_id = b.external_id
                             AND ed.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      JOIN public.sets st ON st.id = ed.set_id
     GROUP BY 1, 2, 3
  ), sets_j AS (
    SELECT product_set_id, count(*)::int AS n,
           jsonb_agg(jsonb_build_object('slug', set_slug, 'name', set_name, 'editions', editions, 'listed', listed,
                                        'fmv_total_usd', fmv_total, 'cheapest_ask_usd', cheapest_ask)
                     ORDER BY editions DESC, set_slug) AS j
      FROM sets_g GROUP BY 1
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

REVOKE EXECUTE ON FUNCTION public.refresh_panini_product_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_product_rollup() TO postgres, service_role;

-- anon-exec: revoked (get_panini_product) — read through the server's service role only; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_panini_product(p_set_id integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT to_jsonb(r) FROM public.panini_product_rollup r
   WHERE r.product_set_id = p_set_id
     AND r.computed_at = (SELECT max(computed_at) FROM public.panini_product_rollup)
$function$;

REVOKE EXECUTE ON FUNCTION public.get_panini_product(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_product(integer) TO postgres, service_role;

SELECT cron.schedule('panini-product-rollup', '6 * * * *', $$SELECT public.refresh_panini_product_rollup()$$);
