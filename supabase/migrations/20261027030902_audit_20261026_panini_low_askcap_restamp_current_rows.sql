-- audit_20261026_panini_low_askcap_restamp_current_rows
-- The one-off half of 20261027030854 (known-issues #202, panini-1.4.1): record, then re-stamp, the CURRENT latest
-- Panini LOW rows that sit above their edition's lowest live ask (listed serials re-read in 7 days) — exactly what
-- the new trigger does to every LOW row written from now on. Measured before apply 2026-10-26 ~8:05 PM PT: 18,662
-- latest LOW rows, 17,577 with a confirmed ask, 2,029 above it (median 2.0x; 75 at >= 10x; $39.3k -> $22.1k).
-- Before-values: public.audit_20261026_panini_low_askcap_backup.
-- REVERT: UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--           FROM public.audit_20261026_panini_low_askcap_backup b WHERE f.id = b.snapshot_id;
WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence, fs.algo_version
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
   ORDER BY fs.edition_id, fs.computed_at DESC
), capped AS (
  SELECT l.id, l.edition_id, l.fmv_usd, l.algo_version, a.ask
    FROM latest l
    JOIN public.editions e ON e.id = l.edition_id
   CROSS JOIN LATERAL (
     SELECT min(s.price_usd) AS ask
       FROM public.panini_card_serials s
      WHERE s.edition_external_id = e.external_id::text
        AND s.is_listed
        AND s.price_usd > 0
        AND s.captured_at > now() - interval '7 days') a
   WHERE l.confidence = 'LOW' AND l.fmv_usd IS NOT NULL AND a.ask > 0 AND l.fmv_usd > a.ask
)
INSERT INTO public.audit_20261026_panini_low_askcap_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT c.id, c.edition_id, c.fmv_usd, round(c.ask::numeric, 2), c.algo_version
  FROM capped c
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_askcap'
  FROM public.audit_20261026_panini_low_askcap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'LOW'
   AND fs.fmv_usd = b.old_fmv_usd;
