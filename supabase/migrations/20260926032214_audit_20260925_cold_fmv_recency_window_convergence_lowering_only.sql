-- 2026-09-25 (PT) — #140 convergence: one lowering-only repricing of the cold
-- population with the estimator 20260926032039 just installed.
--
-- WHY. That migration changes the two cold-population writers, but each only
-- reprices an edition whose newest snapshot is > 7 days old, so the published
-- values it exists to correct would stand for up to a week.
--
-- WHAT. For every edition whose NEWEST snapshot is STALE or SALES_ONLY from
-- one of those writers (1.7.0, cold-tail-1.0, thin-sales-guard-v3), compute the
-- new sample (last 30 paid sales, kept within 90 days of the newest sale, never
-- fewer than the 3 most recent) and, ONLY where it is LOWER than the published
-- FMV, append a snapshot at that median. Lowering-only because the route's
-- writer also caps at the cheapest live ask; a lower value cannot breach a cap
-- the current value already met, while a RAISE is left to the regular writers,
-- which apply the caps. Confidence, collection and counts carry over; the row
-- is labelled algo_version 'recency-window-backfill-20260925' so every row this
-- wrote is identifiable. Measured before apply: 698 editions (All Day 374, UFC
-- 246, Top Shot 71, Golazos 7).
--
-- Revert: DELETE FROM fmv_snapshots WHERE algo_version =
--   'recency-window-backfill-20260925'; (the prior snapshot becomes newest again).

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
       'recency-window-backfill-20260925', now(), p.collection, p.liquidity_rating, p.ask_proxy_fmv
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
WHERE p.confidence::text IN ('STALE', 'SALES_ONLY')
  AND p.algo_version IN ('1.7.0', 'cold-tail-1.0', 'thin-sales-guard-v3')
  AND w.med IS NOT NULL
  AND round(w.med::numeric, 2) < p.fmv_usd;
