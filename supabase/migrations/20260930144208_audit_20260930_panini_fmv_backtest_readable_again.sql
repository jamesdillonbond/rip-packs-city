-- audit_20260930_panini_fmv_backtest_readable_again
--
-- panini_sales_fmv_backtest (20260929063318) stopped answering: on 2026-09-30 it hit a 55 s
-- statement_timeout, after panini_sales grew from ~53k to ~91k rows (38,874 full-history sales).
-- Two per-target look-ups caused it, measured with EXPLAIN over the 14,282 target sales:
--   · serials side: a BitmapAnd of idx_panini_serials_edition with idx_panini_serials_last_sale_at,
--     ~10.9k index rows per target, 460k buffers in all. The new partial index
--     (edition_external_id, last_sale_at DESC) makes it an index scan of the edition's recent sales.
--   · the special-serial filter read a CTE per prior sale. It now probes panini_card_serials_sku_key
--     (unique) with `AND is_special`, the same predicate (`COALESCE(is_special,false)` is true exactly
--     when is_special is true).
-- Output columns, semantics and ACL unchanged (no REVOKE/GRANT: CREATE OR REPLACE VIEW keeps privileges; security_invoker restated, since CREATE OR REPLACE VIEW
-- would otherwise reset reloptions).

CREATE INDEX IF NOT EXISTS idx_panini_serials_edition_last_sale
  ON public.panini_card_serials (edition_external_id, last_sale_at DESC)
  WHERE last_sale_at IS NOT NULL;

CREATE OR REPLACE VIEW public.panini_sales_fmv_backtest
WITH (security_invoker = on) AS
WITH tgt AS (
  SELECT s.edition_external_id AS ed, s.sku, s.sold_at AS t, s.amount_usd AS p,
         EXISTS (SELECT 1 FROM panini_sales_reads r
                  WHERE r.edition_external_id = s.edition_external_id AND r.complete_since <= s.sold_at) AS covered
  FROM panini_sales s
  WHERE s.sold_at > now() - interval '45 days'
    AND s.amount_usd > 0
    AND NOT EXISTS (SELECT 1 FROM panini_card_serials x WHERE x.sku = s.sku AND x.is_special)
), est AS (
  SELECT g.*,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY z.p::float8)
       FROM (SELECT cs.last_sale_usd AS p FROM panini_card_serials cs
              WHERE cs.edition_external_id = g.ed AND cs.last_sale_usd > 0
                AND cs.last_sale_at > g.t - interval '30 days' AND cs.last_sale_at <= g.t - interval '1 day'
                AND NOT COALESCE(cs.is_special, false)
              ORDER BY cs.last_sale_at DESC LIMIT 3) z) AS serials_median3,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY z.p::float8)
       FROM (SELECT s2.amount_usd AS p FROM panini_sales s2
              WHERE s2.edition_external_id = g.ed AND s2.amount_usd > 0
                AND s2.sold_at > g.t - interval '30 days' AND s2.sold_at <= g.t - interval '1 day'
                AND NOT EXISTS (SELECT 1 FROM panini_card_serials x WHERE x.sku = s2.sku AND x.is_special)
              ORDER BY s2.sold_at DESC LIMIT 3) z) AS sales_median3
  FROM tgt g
), long AS (
  SELECT 'serials_median3'::text AS estimator, covered, serials_median3 AS e, p,
         (serials_median3 IS NOT NULL AND sales_median3 IS NOT NULL) AS both_predicted FROM est
  UNION ALL
  SELECT 'sales_median3', covered, sales_median3, p,
         (serials_median3 IS NOT NULL AND sales_median3 IS NOT NULL) FROM est
)
SELECT estimator,
       CASE WHEN covered THEN 'covered' ELSE 'not_covered' END AS edition_coverage,
       CASE WHEN both_predicted THEN 'both' ELSE 'either' END AS target_set,
       count(*) AS n_targets,
       count(e) AS n_predicted,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(e / p::float8 - 1)) * 100)::numeric, 1) AS mdape_pct,
       round(avg((abs(e / p::float8 - 1) <= 0.25)::int) * 100, 1) AS within_25_pct,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(e / p::float8 - 1)) * 100)::numeric, 0) AS p90_ape_pct,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY e / p::float8)::numeric, 3) AS median_ratio,
       45 AS window_days
FROM long
GROUP BY estimator, covered, both_predicted
ORDER BY both_predicted DESC, covered DESC, estimator;

COMMENT ON VIEW public.panini_sales_fmv_backtest IS
  'Head-to-head backtest: median of prior <=3 sales in 30 d, from panini_card_serials (today) vs panini_sales, on the same target sales (last 45 d). Read target_set=both, edition_coverage=covered.';

