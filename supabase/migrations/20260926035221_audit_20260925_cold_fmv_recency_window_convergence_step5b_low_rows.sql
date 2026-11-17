-- 2026-09-25 (PT) — #140 convergence, second population: Step 5b's LOW rows.
--
-- WHY. 20260926032214 repriced the STALE / SALES_ONLY rows of the two cold
-- writers but missed a third label the SAME writer emits: fmv-recalc Step 5b
-- labels a cold edition LOW (not STALE) while its last sale is 30-59 days old
-- (route: `daysSinceSale >= 60 ? "STALE" : "LOW"`). Those rows carry
-- algo_version '1.7.0', sales_count_30d 0 and days_since_sale >= 30, and were
-- still priced by the old last-30 median — All Day 1704 read $126 LOW (7:48 PM
-- PT, before 20260926032039) against 2026 prints of $19-$34.
--
-- WHAT. The same lowering-only repricing with the same sample (last 30 paid
-- sales kept within 90 days of the newest, never fewer than the 3 most
-- recent), for LOW / 1.7.0 / sales_count_30d = 0 / days_since_sale >= 30 rows.
-- Measured before apply: 95 lowered (Golazos 18, Top Shot 48, All Day 29);
-- editions with >= 3 sales in 180 d above 3x that median: All Day 9 -> 0,
-- Golazos 5 -> 0. Tagged 'recency-window-backfill-20260925-low'.
--
-- Revert: DELETE FROM fmv_snapshots WHERE algo_version =
--   'recency-window-backfill-20260925-low';

INSERT INTO fmv_snapshots (
  edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, asp_without_outliers,
  confidence, top_shot_ask, flowty_ask, cross_market_ask,
  sales_count_7d, sales_count_30d, unique_buyers_30d, offer_count, listing_count,
  days_since_sale, velocity_factor, utility_factor, loan_factor,
  algo_version, computed_at, collection, liquidity_rating, ask_proxy_fmv
)
SELECT p.edition_id, p.collection_id, round(w.med::numeric, 2), round(w.mn::numeric, 2),
       round(w.med::numeric, 2), round(w.med::numeric, 2),
       p.confidence, p.top_shot_ask, p.flowty_ask, p.cross_market_ask,
       p.sales_count_7d, p.sales_count_30d, p.unique_buyers_30d, p.offer_count, p.listing_count,
       p.days_since_sale, p.velocity_factor, p.utility_factor, p.loan_factor,
       'recency-window-backfill-20260925-low', now(), p.collection, p.liquidity_rating, p.ask_proxy_fmv
FROM (
  SELECT DISTINCT ON (fs.edition_id) fs.*
  FROM fmv_snapshots fs
  WHERE fs.computed_at > now() - interval '60 days'
  ORDER BY fs.edition_id, fs.computed_at DESC
) p
CROSS JOIN LATERAL (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.price_usd) AS med, min(x.price_usd) AS mn
  FROM (
    SELECT r.price_usd FROM (
      SELECT l.price_usd, l.sold_at,
             row_number() OVER (ORDER BY l.sold_at DESC) AS rn,
             max(l.sold_at) OVER () AS newest
      FROM (
        SELECT s.price_usd, s.sold_at FROM sales s
        WHERE s.edition_id = p.edition_id AND s.price_usd > 0
        ORDER BY s.sold_at DESC LIMIT 30
      ) l
    ) r
    WHERE r.rn <= 3 OR r.sold_at >= r.newest - INTERVAL '90 days'
  ) x
) w
WHERE p.confidence::text = 'LOW'
  AND p.algo_version = '1.7.0'
  AND COALESCE(p.sales_count_30d, 0) = 0
  AND p.days_since_sale >= 30
  AND w.med IS NOT NULL
  AND round(w.med::numeric, 2) < p.fmv_usd;
