-- audit_20261026_panini_low_askcap_sync_edition_fmv_current  (known-issues #202, panini-1.4.1, third file)
-- 20261027030902 re-stamped 2,029 current Panini LOW snapshots IN PLACE (computed_at unchanged), and
-- refresh_edition_fmv_current's incremental path only reads snapshots newer than max(computed_at) - 2 h, so the
-- capped prices would not reach edition_fmv_current (what every page reads) until the 2:36 AM PT full reconcile.
-- This copies the capped value across for exactly those rows, guarded to the row still being that snapshot.
-- Applied 2026-10-26 ~8:19 PM PT: 2,029 of 2,029 synced (e.g. Oukidja Base packcard-1672_314774_7898003_221 $198 -> $1).
-- REVERT: UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd, refreshed_at = now()
--           FROM public.audit_20261026_panini_low_askcap_backup b WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
UPDATE public.edition_fmv_current c
   SET fmv_usd = f.fmv_usd,
       refreshed_at = now()
  FROM public.audit_20261026_panini_low_askcap_backup b
  JOIN public.fmv_snapshots f ON f.id = b.snapshot_id
 WHERE c.edition_id = b.edition_id
   AND c.computed_at = f.computed_at
   AND c.confidence = 'LOW'
   AND c.fmv_usd = b.old_fmv_usd
   AND f.fmv_usd = b.new_fmv_usd;
