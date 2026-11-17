-- audit_20260925_panini_fmv_repair_two_editions_lost_to_delete_then_insert
-- 2026-09-25 6:36 AM PT: one panini-ingest batch (ok=false, fmv_error "TypeError: fetch failed")
-- DELETED today's panini-1.1.0 rows for its editions and then failed to INSERT the replacements.
-- Two editions fell back to their 09-22 panini-1.0.0 row (the top-sales-biased lifetime average):
-- packcard-2332_486956_12680947_408 and packcard-2332_486903_12491223_19 — the only 2 of 5,093
-- editions with no panini-1.1.0 row. This re-prices exactly those two with the 20260925040146 backfill
-- rules; the route fix (insert first, then delete the superseded same-day rows) ships in the same change.
-- Revert: DELETE FROM public.panini_fmv_snapshots WHERE algo_version='panini-1.1.0' AND edition_id IN
--   (SELECT id FROM public.panini_editions WHERE external_id IN ('packcard-2332_486956_12680947_408','packcard-2332_486903_12491223_19'))
--   AND computed_at >= '2026-09-25 16:57:00+00';

WITH tgt AS (
  SELECT id FROM public.panini_editions
   WHERE external_id IN ('packcard-2332_486956_12680947_408', 'packcard-2332_486903_12491223_19')
), l AS (
  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd, confidence, algo_version
    FROM public.panini_fmv_snapshots WHERE edition_id IN (SELECT id FROM tgt)
   ORDER BY edition_id, computed_at DESC
), r AS (
  SELECT * FROM public.panini_recent_sales_fmv((SELECT array_agg(id) FROM tgt))
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
