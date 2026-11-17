-- audit_20260930_panini_published_fmv_backtest
--
-- The instrument for the 10-07 Panini FMV review (week-one review recommendation #3, 2026-09-30).
-- Scores the PUBLISHED price: for every non-special sale in panini_sales in the last 45 days, the
-- latest panini_fmv_snapshots row for that edition computed strictly BEFORE the sale (so no leak —
-- a snapshot can only have seen sales already recorded when it was written), grouped by
-- algo_version and confidence. panini_fmv_backtest reads serial last sales and
-- panini_sales_fmv_backtest re-derives candidate estimators; neither scores what was published, so
-- neither can tell whether panini-1.2.0's LOW tier (shipped 2026-09-30, last <=3 sales at any age)
-- actually beat the 1.1.0 lifetime average live. `covered` = the edition's sales were fully on
-- record at the sale (panini_sales_reads.complete_since <= sold_at). First read 2026-09-30 8:35 PM
-- PT: 1.1.0 LOW n=19, median ratio ~2.5 (the defect); 1.0.0 HIGH n=11,672, ratio 1.70.
-- No anon/authenticated access (ops instrument).
-- Revert: DROP VIEW public.panini_published_fmv_backtest;

CREATE VIEW public.panini_published_fmv_backtest
WITH (security_invoker = on) AS
WITH tgt AS (
  SELECT s.edition_external_id AS ed, s.sold_at AS t, s.amount_usd AS p,
         EXISTS (SELECT 1 FROM panini_sales_reads r
                  WHERE r.edition_external_id = s.edition_external_id AND r.complete_since <= s.sold_at) AS covered
    FROM panini_sales s
   WHERE s.sold_at > now() - interval '45 days'
     AND s.amount_usd > 0
     AND NOT EXISTS (SELECT 1 FROM panini_card_serials x WHERE x.sku = s.sku AND x.is_special)
), pub AS (
  SELECT g.covered, g.p, f.fmv_usd AS e, f.algo_version, f.confidence::text AS confidence
    FROM tgt g
    JOIN panini_editions ed ON ed.external_id = g.ed
    CROSS JOIN LATERAL (
      SELECT f.fmv_usd, f.algo_version, f.confidence
        FROM panini_fmv_snapshots f
       WHERE f.edition_id = ed.id AND f.computed_at < g.t
       ORDER BY f.computed_at DESC
       LIMIT 1) f
   WHERE f.fmv_usd > 0
)
SELECT algo_version,
       confidence,
       CASE WHEN covered THEN 'covered' ELSE 'not_covered' END AS edition_coverage,
       count(*) AS n,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(e / p - 1)) * 100)::numeric, 1) AS mdape_pct,
       round(avg((abs(e / p - 1) <= 0.25)::int) * 100, 1) AS within_25_pct,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(e / p - 1)) * 100)::numeric, 0) AS p90_ape_pct,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY e / p))::numeric, 3) AS median_ratio,
       45 AS window_days
  FROM pub
 GROUP BY algo_version, confidence, covered
 ORDER BY algo_version DESC, confidence, covered DESC
;

COMMENT ON VIEW public.panini_published_fmv_backtest IS
  'Published Panini FMV vs the next real sale: per (algo_version, confidence, coverage), the latest snapshot computed '
  'before each non-special sale in the last 45 days. MdAPE, share within ±25 %, p90, median est/actual ratio. Built '
  '2026-09-30 to measure panini-1.2.0 (LOW from last sales) live at the 10-07 review.';

REVOKE ALL ON public.panini_published_fmv_backtest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_published_fmv_backtest TO service_role;
