-- audit_20260923_panini_fmv_backtest
--
-- Makes Panini FMV accuracy MEASURABLE out of sample, the platform's gate metric. Measured
-- 2026-09-23 ~10 PM PT over 4,432 realized non-special serial sales (45 days), each compared to
-- the FMV we had published MORE THAN A DAY BEFORE the sale:
--   published FMV:  median abs error 35.9%, 38.1% within +/-25%, median ratio 1.106 (biased HIGH)
--   HIGH-confidence rows alone: 35.3% / 38.5% — the label overclaims.
--   naive "last sale in the edition" beat it (25.0%); median of last 3 sales in 30 d, falling
--   back to published: 25.0% / 50.5% / ratio 1.000.
-- By prior-sale recency: <7 d  published 36.5% vs last-3 median 21.4%; 7-30 d 28.6 vs 25.0;
-- >30 d published is better (40.0 vs 45.0) — hence the fallback.
-- Published FMV is toFmvRow (lib/chains/panini/ingest-normalize.ts): avg_sale || recent_sale
-- from getCardMarketStats, confidence from cumulative volume_txns, no recency term.
-- Ops-only (service_role). Revert: DROP VIEW public.panini_fmv_backtest;

CREATE VIEW public.panini_fmv_backtest WITH (security_invoker = on) AS
WITH sales AS (
  SELECT e.id AS eid, cs.last_sale_usd AS p, cs.last_sale_at AS t
    FROM public.panini_card_serials cs
    JOIN public.panini_editions e ON e.external_id = cs.edition_external_id
   WHERE cs.last_sale_usd > 0 AND cs.last_sale_at IS NOT NULL AND NOT COALESCE(cs.is_special, false)
), w AS (
  SELECT s.*, array_agg(p) OVER (PARTITION BY eid ORDER BY t
           RANGE BETWEEN interval '30 days' PRECEDING AND interval '1 day' PRECEDING) AS prior
    FROM sales s
), tgt AS (
  SELECT eid, p, t, prior[greatest(array_length(prior, 1) - 2, 1):] AS l3
    FROM w WHERE t > now() - interval '45 days'
), j AS (
  SELECT g.p, f.fmv_usd AS published, f.confidence::text AS confidence,
         COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) FROM unnest(g.l3) v), f.fmv_usd) AS candidate,
         (g.l3 IS NOT NULL) AS has_recent_sales
    FROM tgt g
    CROSS JOIN LATERAL (
      SELECT x.fmv_usd, x.confidence FROM public.panini_fmv_snapshots x
       WHERE x.edition_id = g.eid AND x.computed_at < g.t - interval '1 day'
       ORDER BY x.computed_at DESC LIMIT 1) f
   WHERE f.fmv_usd > 0
), long AS (
  SELECT 'published'::text AS estimator, confidence, has_recent_sales, published AS est, p FROM j
  UNION ALL
  SELECT 'recent_median3_30d_else_published', confidence, has_recent_sales, candidate, p FROM j
)
SELECT estimator,
       COALESCE(confidence, 'ALL') AS published_confidence,
       count(*) AS n_sales,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(est / p - 1)) * 100)::numeric, 1) AS mdape_pct,
       round(avg((abs(est / p - 1) <= 0.25)::int) * 100, 1)                                    AS within_25_pct,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(est / p - 1)) * 100)::numeric, 0) AS p90_ape_pct,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY est / p))::numeric, 3)                AS median_ratio,
       round(avg(has_recent_sales::int) * 100, 1)                                               AS pct_with_recent_sales,
       45 AS window_days
  FROM long
 GROUP BY estimator, ROLLUP (confidence)
 ORDER BY estimator, published_confidence;

REVOKE ALL ON public.panini_fmv_backtest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_fmv_backtest TO service_role;

COMMENT ON VIEW public.panini_fmv_backtest IS
  'OUT-OF-SAMPLE accuracy of Panini FMV. For every realized non-special serial sale in the last 45 days, '
  'compares the price to (a) the FMV we PUBLISHED more than a day before the sale and (b) a candidate: the '
  'median of the edition''s last 3 non-special sales in the 30 days before (excluding the sale''s own day), '
  'falling back to the published FMV. mdape = median absolute % error; within_25 = share within +/-25%. '
  'Baseline 2026-09-23 ~10 PM PT: published HIGH mdape 35.3%, only 38.5% within 25%, and naive last-sale '
  'beat it (25.0%). ⚠ Ground truth is panini_card_serials.last_sale_* = only the LATEST sale per DISCOVERED '
  'serial (41% of sold serials were undiscovered on 09-23), so n grows as serial paging lands. Ops-only.';
