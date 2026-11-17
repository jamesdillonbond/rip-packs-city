-- audit_20261023_stale_salescap_restamp_current_rows
-- The one-off half of 20261023222201 (known-issues #209): record, then re-stamp, the CURRENT latest
-- NBA Top Shot / NFL All Day STALE rows that sit above their edition's last market sale — exactly what
-- the new trigger does to every STALE row written from now on. Measured before apply: TS 14 of 49 with a
-- qualifying sale (median 1.33×), AD 189 of 512 (median 1.60×). Applied 2026-10-23 3:22 PM PT: 203 rows
-- backed up and re-stamped, 0 missed. Before-values: public.audit_20261023_stale_salescap_backup.
-- REVERT: UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--           FROM public.audit_20261023_stale_salescap_backup b WHERE f.id = b.snapshot_id;
WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.collection_id, fs.fmv_usd, fs.confidence, fs.algo_version
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'dee28451-5d62-409e-a1ad-a83f763ac070')
   ORDER BY fs.edition_id, fs.computed_at DESC
), capped AS (
  SELECT l.id, l.edition_id, l.collection_id, l.fmv_usd, l.algo_version, o.last1
    FROM latest l
   CROSS JOIN LATERAL (
     SELECT y.price_usd AS last1
       FROM public.sales_market y
      WHERE y.edition_id = l.edition_id
        AND y.price_usd > 0
        AND COALESCE(y.serial_number, 999999) > 25
      ORDER BY y.sold_at DESC LIMIT 1) o
   WHERE l.confidence = 'STALE' AND l.fmv_usd IS NOT NULL AND o.last1 > 0 AND l.fmv_usd > o.last1
)
INSERT INTO public.audit_20261023_stale_salescap_backup (snapshot_id, edition_id, collection_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT c.id, c.edition_id, c.collection_id, c.fmv_usd, round(c.last1::numeric, 2), c.algo_version
  FROM capped c
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_stalecap'
  FROM public.audit_20261023_stale_salescap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'STALE'
   AND fs.fmv_usd = b.old_fmv_usd;
