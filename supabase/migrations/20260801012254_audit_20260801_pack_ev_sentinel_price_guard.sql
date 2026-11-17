-- audit_20260801_pack_ev_sentinel_price_guard
--
-- Exclude sentinel-priced / non-purchasable distributions from the EV publish stack.
-- pack_table_rows (the pack detail page) ALREADY applies `pev.pack_price < 9999` in its
-- LEFT JOIN, but three anon-readable sibling views did not, so internal Dapper "holding"
-- packs and price-corrupted rows reached user surfaces:
--   v_allday_pack_info            17 rows (incl. "NFL Pack Hold - Genesis" $999,999 / gross_ev $900,000)
--   v_topshot_pack_ev_calibrated   5 rows (2x $1,000,000 team packs, $200,000, $40,000, $17,000)
--   v_topshot_pack_market          3 rows (public /insights/topshot-pack-market board)
--
-- Threshold is safe by inspection: live pack_price has a hard gap between $2,998 (the most
-- expensive legitimate pack, "Top Shot 50 (Release 1)") and $9,999 (Dapper's sentinel) --
-- zero rows sit in between, at any price_source. Name-matching was rejected: "Series 1
-- Reserve Pack" (6,109 minted, $344) is a legitimate consumer pack that a /hold|reserve/
-- regex would wrongly suppress.
--
-- KNOWN REMAINING DIVERGENCE (deliberate, documented): mv_pack_ev_latest is a hand-copied
-- query, NOT a mirror of pack_ev_latest. It still lacks this price guard, the TopShot
-- troll-ask guard, and the sentinel-NULLing CASE arms (291 rows where it publishes a
-- fabricated gross_ev = 0.00 that this view correctly reports as NULL). Neither reaches a
-- user surface today: pack_table_rows re-applies both guards in its own LEFT JOIN, and
-- v_topshot_pack_market is guarded locally below. Collapsing the MV to
-- `SELECT * FROM pack_ev_latest` is the structural fix but needs DROP ... CASCADE plus a
-- verbatim rebuild of pack_table_rows + v_topshot_pack_market, so it is left as a
-- separately-verified change rather than bundled here.
--
-- Revert: re-run this file with the `AND pack_price < 9999::numeric` line removed from
-- pack_ev_latest and the `AND mv_pack_ev_latest.pack_price < 9999::numeric` line removed
-- from the v_topshot_pack_market `ev` CTE (then re-assert security_invoker on the latter).

CREATE OR REPLACE VIEW public.pack_ev_latest AS
 SELECT DISTINCT ON (pack_listing_id) pack_listing_id,
    collection_id,
    dist_id,
    pack_name,
    pack_price,
        CASE
            WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::numeric
            ELSE gross_ev
        END::numeric(10,2) AS gross_ev,
        CASE
            WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::numeric
            ELSE pack_ev
        END::numeric(10,2) AS pack_ev,
        CASE
            WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::boolean
            ELSE is_positive_ev
        END AS is_positive_ev,
        CASE
            WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::numeric
            ELSE value_ratio
        END::numeric(12,4) AS value_ratio,
        CASE
            WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::smallint
            ELSE fmv_coverage_pct
        END AS fmv_coverage_pct,
    edition_count,
    total_unopened,
        CASE
            WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::smallint
            ELSE depletion_pct
        END AS depletion_pct,
    snapshotted_at,
    primary_price,
    secondary_ask,
    price_source,
    primary_available,
    secondary_available,
        CASE
            WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::numeric
            ELSE typical_ev
        END::numeric(10,2) AS typical_ev
   FROM pack_ev_history
  WHERE pack_ev >= '-10000'::integer::numeric
    AND pack_ev <= 1000000::numeric
    AND pack_price > 0::numeric
    AND pack_price < 9999::numeric
    AND pack_name !~~ 'Holding %'::text
    AND NOT (collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND (EXISTS ( SELECT 1
           FROM pack_ask_state a
          WHERE a.collection_slug = 'nba-top-shot'::text AND a.dist_id = pack_ev_history.dist_id AND a.is_listed IS TRUE AND a.lowest_ask > 0::numeric AND pack_ev_history.gross_ev > (3::numeric * a.lowest_ask))))
  ORDER BY pack_listing_id, snapshotted_at DESC;

COMMENT ON VIEW public.pack_ev_latest IS
  'Latest EV snapshot per pack_listing_id. Publish guards: pack_ev within [-10000,1000000]; pack_price in (0, 9999) -- the upper bound excludes Dapper internal "holding"/reserve distributions and price-corrupted rows (hard data gap between $2,998 legit max and the $9,999 sentinel); TopShot rows whose gross_ev exceeds 3x a live listed ask are suppressed as troll-ask artifacts. gross_ev/pack_ev/value_ratio/... are NULLed (not zeroed) when a sentinel row (gross_ev=0 AND edition_count=0) is the latest snapshot, so "no data" never renders as "$0.00". NOTE: mv_pack_ev_latest is a SEPARATE hand-copied query, not a mirror of this view -- any guard added here must be added there too.';

-- v_topshot_pack_market reads mv_pack_ev_latest (not this view), so it needs the guard
-- applied locally. security_invoker must be re-asserted: CREATE OR REPLACE VIEW drops reloptions.
CREATE OR REPLACE VIEW public.v_topshot_pack_market AS
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
        ), ev AS (
         SELECT DISTINCT ON (mv_pack_ev_latest.dist_id) mv_pack_ev_latest.dist_id,
            mv_pack_ev_latest.pack_price
           FROM mv_pack_ev_latest
          WHERE mv_pack_ev_latest.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
            AND mv_pack_ev_latest.pack_price < 9999::numeric
          ORDER BY mv_pack_ev_latest.dist_id, mv_pack_ev_latest.snapshotted_at DESC
        )
 SELECT s.dist_id,
    COALESCE(d.title, ( SELECT d2.metadata ->> 'name'::text
           FROM pack_distributions d2
          WHERE d2.dist_id = d.dist_id AND d2.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)) AS title,
    sup.total_minted AS drop_size,
    sup.depletion_pct,
    ev.pack_price AS retail_price,
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
            WHEN ev.pack_price > 0::numeric AND s.median_price_90d IS NOT NULL THEN round(s.median_price_90d / ev.pack_price, 2)
            ELSE NULL::numeric
        END AS secondary_vs_retail_ratio
   FROM s
     LEFT JOIN pack_distributions d ON d.dist_id = s.dist_id AND d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     LEFT JOIN ev ON ev.dist_id = s.dist_id
     LEFT JOIN topshot_pack_supply sup ON sup.dist_id = s.dist_id;

ALTER VIEW public.v_topshot_pack_market SET (security_invoker = on);
