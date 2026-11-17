-- audit_20260924_panini_fmv_1_1_0_backfill
-- One-time: gives every Panini edition a panini-1.1.0 snapshot at ship time (2026-09-24 9:01 PM PT)
-- so the squeeze board is not mixed-engine for the ~3-day walk rotation. Same rules as toFmvRowV11:
-- recent-sales median (HIGH 3 / MEDIUM 1-2) > lifetime avg as LOW > ASK_ONLY floor x 0.50 (floor =
-- panini_editions.serial_low_ask_usd, else the old ASK_ONLY fmv / 0.9). The ingest route's per-day
-- delete-then-insert replaces these rows as each edition is walked. Result: 5,093 editions ->
-- 777 HIGH / 926 MEDIUM / 2,680 LOW / 710 ASK_ONLY.
-- Revert: DELETE FROM public.panini_fmv_snapshots WHERE algo_version = 'panini-1.1.0'
--         AND computed_at >= '2026-09-25 04:01:00+00';  (and set PANINI_FMV_ENGINE=1.0)

WITH l AS (
  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd, confidence, algo_version
    FROM public.panini_fmv_snapshots ORDER BY edition_id, computed_at DESC
), r AS (
  SELECT * FROM public.panini_recent_sales_fmv((SELECT array_agg(id) FROM public.panini_editions))
), n AS (
  SELECT l.edition_id,
         CASE WHEN r.edition_id IS NOT NULL THEN r.fmv_usd
              WHEN l.confidence IN ('HIGH','MEDIUM','LOW') THEN l.fmv_usd
              WHEN l.confidence = 'ASK_ONLY' AND e.serial_low_ask_usd > 0 THEN round(e.serial_low_ask_usd * 0.5, 2)
              WHEN l.confidence = 'ASK_ONLY' THEN round(l.fmv_usd / 0.9 * 0.5, 2) END AS fmv_usd,
         CASE WHEN r.edition_id IS NOT NULL THEN (CASE WHEN r.n_recent >= 3 THEN 'HIGH' ELSE 'MEDIUM' END)
              WHEN l.confidence IN ('HIGH','MEDIUM','LOW') THEN 'LOW'
              WHEN l.confidence = 'ASK_ONLY' THEN 'ASK_ONLY' END AS confidence
    FROM l JOIN public.panini_editions e ON e.id = l.edition_id
    LEFT JOIN r ON r.edition_id = l.edition_id
   WHERE l.algo_version = 'panini-1.0.0'
)
INSERT INTO public.panini_fmv_snapshots (edition_id, fmv_usd, confidence, algo_version, computed_at)
SELECT edition_id, fmv_usd, confidence::public.fmv_confidence, 'panini-1.1.0', now()
  FROM n WHERE fmv_usd IS NOT NULL AND fmv_usd > 0 AND confidence IS NOT NULL;
