-- audit_20260928_panini_sales_fmv_backtest
--
-- The instrument for one decision: should panini_recent_sales_fmv (the panini-1.1.0 FMV input —
-- median of the edition's last <=3 non-special sales in 30 days) read panini_sales instead of
-- panini_card_serials' one-last-sale-per-card? panini_sales is a SUPERSET (its seeds are those
-- last sales; the walk adds every repeat sale it reads), so the same method can only see more
-- real sales — but a price change needs a MEASUREMENT, not that argument (measured 2026-09-28:
-- 1 of 19 comparable editions differed; too small a sample to decide).
--
-- HEAD-TO-HEAD ON THE SAME TARGETS. Every non-special sale in panini_sales in the last 45 days is
-- predicted twice, by the median of the prior <=3 sales in (t - 30 d, t - 1 d] of its edition:
--   serials_median3 — prior sales from panini_card_serials.last_sale_* (today's source; the same
--                     as-of-now snapshot panini_fmv_backtest uses)
--   sales_median3   — prior sales from panini_sales (full records + seeds)
-- A target with no prior sale under an estimator has no prediction there and is counted apart
-- (`n_predicted`), so neither side is scored on a set the other did not face: `both` rows are
-- the targets BOTH estimators predicted. `covered` splits editions whose sales are fully on record
-- (panini_sales_reads.complete_since at or before the target) — the population the decision is
-- about. Metrics match panini_fmv_backtest: median absolute % error, share within ±25%, p90,
-- median est/actual ratio.
--
-- On demand only (manual reads by an operator); service-role only.

CREATE OR REPLACE VIEW public.panini_sales_fmv_backtest
WITH (security_invoker = on) AS
WITH special AS (
  SELECT sku FROM panini_card_serials WHERE COALESCE(is_special, false)
), tgt AS (
  SELECT s.edition_external_id AS ed, s.sku, s.sold_at AS t, s.amount_usd AS p,
         EXISTS (SELECT 1 FROM panini_sales_reads r
                  WHERE r.edition_external_id = s.edition_external_id AND r.complete_since <= s.sold_at) AS covered
  FROM panini_sales s
  WHERE s.sold_at > now() - interval '45 days'
    AND s.amount_usd > 0
    AND NOT EXISTS (SELECT 1 FROM special x WHERE x.sku = s.sku)
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
                AND NOT EXISTS (SELECT 1 FROM special x WHERE x.sku = s2.sku)
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

REVOKE ALL ON public.panini_sales_fmv_backtest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_sales_fmv_backtest TO service_role;
