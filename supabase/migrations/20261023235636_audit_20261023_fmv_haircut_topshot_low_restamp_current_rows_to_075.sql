-- audit_20261023_fmv_haircut_topshot_low_restamp_current_rows_to_075
--
-- Companion to 20261023235545 (the haircut ladder's Top Shot LOW unknown-depth arm 0.55 -> 0.75).
-- The function only cuts a row sitting AT the floor, so the 497 current latest Top Shot LOW
-- haircut rows already cut to 0.55 would otherwise stay there until the sweep rewrote them
-- (all are < 7 days old, so ~a week). This re-stamps them to ROUND(floor * 0.75, 2) in place —
-- algo_version unchanged (still '<engine>_haircut'), confidence unchanged, floor untouched —
-- with the before-values kept in audit_20261023_ts_low_haircut_075_backup.
-- Pre-measured: 497 rows, every one at ROUND(floor * 0.55, 2); $3,455.95 -> $4,712.67 summed.
-- Applied 2026-10-23 ~4:57 PM PT (Cowork cloud); verified after apply: 497 backed up, 497 at
-- 0.75, $3,455.95 -> $4,712.67 exactly, 0 labels or algo_versions moved.
--
-- REVERT: UPDATE fmv_snapshots f SET fmv_usd = b.old_fmv_usd
--           FROM audit_20261023_ts_low_haircut_075_backup b WHERE f.id = b.snapshot_id;

CREATE TABLE IF NOT EXISTS public.audit_20261023_ts_low_haircut_075_backup AS
WITH latest AS (
  SELECT DISTINCT ON (edition_id) id, edition_id, fmv_usd, floor_price_usd, algo_version, computed_at
  FROM public.fmv_snapshots
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  ORDER BY edition_id, computed_at DESC
)
SELECT id AS snapshot_id, edition_id, fmv_usd AS old_fmv_usd, floor_price_usd, algo_version, computed_at, now() AS backed_up_at
FROM latest
WHERE algo_version LIKE '%\_haircut' AND floor_price_usd IS NOT NULL
  AND ABS(fmv_usd - ROUND(floor_price_usd * 0.55, 2)) < 0.011
  AND id IN (SELECT id FROM public.fmv_snapshots s WHERE s.id = latest.id AND s.confidence = 'LOW' AND COALESCE(s.sales_count_30d, 0) = 0);

ALTER TABLE public.audit_20261023_ts_low_haircut_075_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261023_ts_low_haircut_075_backup FROM PUBLIC, anon, authenticated;

UPDATE public.fmv_snapshots f
SET fmv_usd = ROUND(f.floor_price_usd * 0.75, 2)
FROM public.audit_20261023_ts_low_haircut_075_backup b
WHERE f.id = b.snapshot_id
  AND f.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND f.confidence = 'LOW'
  AND ABS(f.fmv_usd - b.old_fmv_usd) < 0.001;
