-- scripts/allday-dispersion-gate-read.sql — the weekly All Day dispersion-gate read (nfl-all-day.md, "the 0.35
-- dispersion gate stays … re-read it weekly"). Is the LOW set with 7+ sales in 30 days (LOW only because of the
-- 0.35 dispersion gate) as accurate as MEDIUM? If it stays level, the gate is mislabelling it; if not, it stays LOW.
--
-- Method (codified 2026-10-26 from the 10-21 read, which left no script): every All Day sale in the last 14 days with
-- serial > 25 (low serials carry premiums the edition FMV does not), scored against the snapshot IN FORCE ONE DAY
-- BEFORE the sale (no same-day peeking), grouped by that snapshot's label and its sales_count_30d.
-- ✅ Validated 2026-10-26 by reproducing 10-21 exactly with the window ending 2026-10-21 07:15 PT:
--    LOW 7+ n 873 · 22.0 % median error · 57.7 % within ±25 % · $0.05   (10-21 recorded: 874 · 22.1 · 57.7 · $0.05)
--    MEDIUM  n 3,459 · 18.8 % · 61.3 % · $0.04                           (10-21 recorded: 3,451 · 18.8 · 61.2 · $0.04)
--    (the n drift is sales ingested since.)
-- Read on median error and within ±25 % — not WAPE (one $200 print on a $0.17 edition dominates it).
-- Read-only, ~5–10 s. To reproduce a past read, replace now() with the read's timestamp in both places.

WITH s AS (
  SELECT s.edition_id, s.sold_at, s.price_usd::numeric AS p
    FROM sales_market s
   WHERE s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
     AND s.serial_number > 25 AND s.price_usd > 0
     AND s.sold_at >= now() - interval '14 days' AND s.sold_at < now()
), j AS (
  SELECT s.p, f.fmv_usd::numeric AS e, f.confidence::text AS c, f.sales_count_30d AS n30
    FROM s
   CROSS JOIN LATERAL (SELECT fmv_usd, confidence, sales_count_30d FROM fmv_snapshots f
                        WHERE f.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
                          AND f.edition_id = s.edition_id AND f.computed_at <= s.sold_at - interval '1 day'
                        ORDER BY f.computed_at DESC LIMIT 1) f
   WHERE f.fmv_usd > 0
)
SELECT CASE WHEN c = 'LOW' AND n30 >= 7 THEN 'LOW 7+'
            WHEN c = 'MEDIUM' AND n30 BETWEEN 5 AND 6 THEN 'MEDIUM (5-6 sales)'
            WHEN c = 'MEDIUM' THEN 'MEDIUM (7+ sales)'
            WHEN c = 'HIGH' THEN 'HIGH' END AS grp,
       count(*) AS n,
       round(100 * percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(e / p - 1))::numeric, 1) AS median_err_pct,
       round(100.0 * avg((abs(e / p - 1) <= 0.25)::int), 1)                                 AS within25_pct,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(e - p))::numeric, 2)           AS median_miss_usd
  FROM j
 WHERE (c = 'LOW' AND n30 >= 7) OR c IN ('MEDIUM', 'HIGH')
 GROUP BY 1
 ORDER BY 1;
-- Compare 'LOW 7+' with MEDIUM as a whole (5-6 and 7+ together): on 2026-10-26 MEDIUM all = n 3,061 · 20.0 % · 57.3 %.
