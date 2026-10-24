-- scripts/panini-fmv-paired-read.sql — the Panini FMV "paired read": every sale since a cutoff
-- scored against the snapshot in force BEFORE it (the published price) AND against the naive
-- median of the edition's last <= 3 prior sales on the SAME rows, per engine version and tier.
--
-- Why paired: the plain view (panini_published_fmv_backtest) ranks engines on different
-- populations — the walk weighting puts 1.3.x on World Cup editions first, a harder set — so a
-- lower within-±25 % can be harder rows, not a worse engine. The gap to naive on the same rows
-- is the engine's own number. Method as first used 2026-10-20 ~8:15 PM PT (panini.md, Now 1):
-- covered editions (a complete sales read predates the sale), non-special serials, cutoff
-- 2026-10-15 noon PT. Codified 2026-10-23 (Cowork cloud) for the 1.4.0 decision (on/after 10-24).
--
-- Read-only. ~10–20 s. Re-run with a later cutoff as the window moves; keep the cutoff at least
-- ~5 days back (sales land 12–160 h after sold_at).
--
-- Columns: n · pub_within25 / naive3_within25 (% within ±25 %) · pub_wape / naive3_wape
-- (dollar-weighted abs error %) · pub_ratio (median published / realised). Read the GAP
-- (pub − naive) per tier, and the order HIGH > MEDIUM > LOW on pub_within25.

WITH tgt AS (
  SELECT s.edition_external_id AS ed, s.sold_at AS t, s.amount_usd::numeric AS p
  FROM panini_sales s
  WHERE s.sold_at >= '2026-10-15 12:00-07'                       -- the cutoff; move it forward
    AND s.amount_usd > 0
    AND NOT EXISTS (SELECT 1 FROM panini_card_serials x WHERE x.sku = s.sku AND x.is_special)
    AND EXISTS (SELECT 1 FROM panini_sales_reads r
                 WHERE r.edition_external_id = s.edition_external_id AND r.complete_since <= s.sold_at)
), pub AS (
  SELECT g.p, f.fmv_usd::numeric AS e, f.algo_version, f.confidence::text AS conf, n3.med3::numeric AS med3
  FROM tgt g
  JOIN panini_editions ed ON ed.external_id = g.ed
  CROSS JOIN LATERAL (SELECT f1.fmv_usd, f1.algo_version, f1.confidence
                        FROM panini_fmv_snapshots f1
                       WHERE f1.edition_id = ed.id AND f1.computed_at < g.t
                       ORDER BY f1.computed_at DESC LIMIT 1) f
  CROSS JOIN LATERAL (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.amount_usd::double precision) AS med3
                        FROM (SELECT s2.amount_usd FROM panini_sales s2
                               WHERE s2.edition_external_id = g.ed AND s2.sold_at < g.t AND s2.amount_usd > 0
                                 AND NOT EXISTS (SELECT 1 FROM panini_card_serials x WHERE x.sku = s2.sku AND x.is_special)
                               ORDER BY s2.sold_at DESC LIMIT 3) x) n3
  WHERE f.fmv_usd > 0 AND n3.med3 IS NOT NULL
)
SELECT algo_version, conf, count(*) AS n,
       round(100.0 * avg((abs(e / p - 1) <= 0.25)::int), 1)    AS pub_within25,
       round(100.0 * avg((abs(med3 / p - 1) <= 0.25)::int), 1) AS naive3_within25,
       round(100.0 * sum(abs(e - p)) / sum(p), 1)              AS pub_wape,
       round(100.0 * sum(abs(med3 - p)) / sum(p), 1)           AS naive3_wape,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY (e / p)::double precision))::numeric, 3) AS pub_ratio
FROM pub
WHERE algo_version IN ('panini-1.4.0', 'panini-1.3.1', 'panini-1.3.0', 'panini-1.2.0')   -- 1.4.0 shipped 2026-10-24 (20261024152200)
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
