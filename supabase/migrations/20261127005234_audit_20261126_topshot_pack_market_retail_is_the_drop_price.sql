-- 2026-11-26 (Claude Code cloud, autonomous pass). v_topshot_pack_market.retail_price is the pack's DROP price,
-- not today's lowest secondary ask.
--
-- WHY. The view took retail_price from mv_pack_ev_latest.pack_price. Measured 11-26: for ALL 1,852 Top Shot
-- dists in that MV, pack_price = secondary_ask (price_source 'secondary', primary_price NULL), so "retail"
-- was the live lowest ask. /insights/topshot-pack-market ("rank them by discount-to-retail") printed e.g.
-- "Holiday of Hoops: Trade Ticket · Retail $69.99 · median $7.74 · 0.11x" (its drop price is $10.00, so
-- 0.77x), and every pack page's sealed-resale line said "trades 1.20x retail" against the ask (dist 8596, a
-- case topper with no standalone retail, read "Retail $209"). The real drop price
-- (pack_distributions.metadata.retail_price_usd) agreed with the old column on 26 of 1,356 qualifying dists.
--
-- NOW. retail_price = the drop price, normalized exactly as pack_table_rows does (a value >= 1,000,000 is a
-- UFix64 x1e8), the same source the pack page's own price line uses. 0 ("no standalone retail": reward, box
-- and case packs) and holding-pack sentinels (>= 9,999) are NULL, so they get no ratio and no verdict
-- (pack-market-board.ts already ranks only rows with retail > 0). 245 qualifying dists keep a ratio (118
-- below 0.85x, 93 above 1.15x). Same columns, names and types; security_invoker restated because CREATE OR
-- REPLACE VIEW resets reloptions; grants are kept by REPLACE.
--
-- REVERT: re-create the view from 20260924122704 (retail_price := ev.pack_price, with the ev CTE over
-- mv_pack_ev_latest), WITH (security_invoker = on).
CREATE OR REPLACE VIEW public.v_topshot_pack_market WITH (security_invoker = on) AS
 WITH s AS (
         SELECT mv_topshot_pack_sales_agg.dist_id,
            mv_topshot_pack_sales_agg.n_sales,
            mv_topshot_pack_sales_agg.n_sales_30d,
            mv_topshot_pack_sales_agg.n_sales_90d,
            mv_topshot_pack_sales_agg.avg_price_90d,
            mv_topshot_pack_sales_agg.median_price_90d,
            mv_topshot_pack_sales_agg.min_price_all,
            mv_topshot_pack_sales_agg.max_price_all,
            mv_topshot_pack_sales_agg.last_sale_price,
            mv_topshot_pack_sales_agg.last_sale_at,
            mv_topshot_pack_sales_agg.first_sale_at
           FROM mv_topshot_pack_sales_agg
        ), drop_price AS (
         SELECT d.dist_id,
                CASE
                    WHEN ((d.metadata ->> 'retail_price_usd'::text) IS NULL) THEN NULL::numeric
                    WHEN (((d.metadata ->> 'retail_price_usd'::text))::numeric >= (1000000)::numeric) THEN round((((d.metadata ->> 'retail_price_usd'::text))::numeric / (100000000)::numeric), 2)
                    ELSE round(((d.metadata ->> 'retail_price_usd'::text))::numeric, 2)
                END AS price
           FROM pack_distributions d
          WHERE (d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
        ), r AS (
         SELECT drop_price.dist_id,
                CASE
                    WHEN ((drop_price.price > (0)::numeric) AND (drop_price.price < (9999)::numeric)) THEN drop_price.price
                    ELSE NULL::numeric
                END AS retail
           FROM drop_price
        )
 SELECT s.dist_id,
    COALESCE(d.title, ( SELECT (d2.metadata ->> 'name'::text)
           FROM pack_distributions d2
          WHERE ((d2.dist_id = d.dist_id) AND (d2.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)))) AS title,
    sup.total_minted AS drop_size,
    sup.depletion_pct,
    (r.retail)::numeric(10,2) AS retail_price,
    s.n_sales,
    s.n_sales_30d,
    s.n_sales_90d,
    s.last_sale_price,
    s.last_sale_at,
    s.avg_price_90d,
    s.median_price_90d,
    s.min_price_all,
    s.max_price_all,
    s.first_sale_at,
        CASE
            WHEN ((r.retail > (0)::numeric) AND (s.median_price_90d IS NOT NULL)) THEN round((s.median_price_90d / r.retail), 2)
            ELSE NULL::numeric
        END AS secondary_vs_retail_ratio
   FROM (((s
     LEFT JOIN pack_distributions d ON (((d.dist_id = s.dist_id) AND (d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid))))
     LEFT JOIN r ON ((r.dist_id = s.dist_id)))
     LEFT JOIN topshot_pack_supply sup ON ((sup.dist_id = s.dist_id)));
