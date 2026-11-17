-- audit_20261110_panini_thin_high_relabel_to_medium
-- Applied 2026-11-10 ~2:00 PM PT: 14,214 backed up, 14,214 re-labelled, 14,214 edition_fmv_current rows synced (Elephant /20 now MEDIUM, $159 unchanged).
-- The one-off half of panini-1.4.2 (3bbc171, 2026-11-09): "HIGH needs >= 3 sales in the 30-day feed, else
-- MEDIUM". The engine applies the rule only when it re-walks an edition, so on 2026-11-10 16,086 Panini editions
-- still carried a panini-1.4.0 HIGH as their latest snapshot, 14,214 of them on < 3 recent sales (e.g. Yan
-- Diomande Base Choice Prizms Elephant /20: $159 HIGH from 11-05 on 2 sales, the 11-08 concierge complaint #12218).
-- This applies the same rule to those rows IN PLACE (computed_at unchanged — nothing was re-priced): confidence
-- HIGH -> MEDIUM and algo_version gains `_thinhigh`. PRICES ARE UNCHANGED, so the HIGH+MEDIUM share is unchanged.
-- Confidence is internal-only (never shown); it reaches the concierge's wording and internal gates.
-- "Recent sales" is exactly panini_recent_sales_fmv_v2's count: non-special panini_sales in 30 days, capped at 3.
-- Then edition_fmv_current (what pages and the concierge read) is synced for exactly those rows, guarded to the
-- row still being that snapshot (refresh_edition_fmv_current's incremental path does not see an in-place edit).
-- Before-values: public.audit_20261110_panini_thin_high_backup.
-- REVERT:
--   UPDATE public.fmv_snapshots f SET confidence = 'HIGH', algo_version = b.old_algo_version
--     FROM public.audit_20261110_panini_thin_high_backup b WHERE f.id = b.snapshot_id AND f.confidence = 'MEDIUM';
--   UPDATE public.edition_fmv_current c SET confidence = 'HIGH', refreshed_at = now()
--     FROM public.audit_20261110_panini_thin_high_backup b WHERE c.edition_id = b.edition_id AND c.computed_at = b.computed_at AND c.confidence = 'MEDIUM';

CREATE TABLE IF NOT EXISTS public.audit_20261110_panini_thin_high_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  computed_at timestamptz NOT NULL,
  old_algo_version text,
  n_recent integer NOT NULL,
  relabelled_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261110_panini_thin_high_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261110_panini_thin_high_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.computed_at, fs.confidence, fs.algo_version
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     AND fs.computed_at > now() - interval '60 days'
   ORDER BY fs.edition_id, fs.computed_at DESC
)
INSERT INTO public.audit_20261110_panini_thin_high_backup (snapshot_id, edition_id, computed_at, old_algo_version, n_recent)
SELECT l.id, l.edition_id, l.computed_at, l.algo_version, k.n
  FROM latest l
  JOIN public.editions e ON e.id = l.edition_id
 CROSS JOIN LATERAL (
   SELECT count(*)::int AS n FROM (
     SELECT 1 FROM public.panini_sales s
      WHERE s.edition_external_id = e.external_id
        AND s.amount_usd > 0
        AND s.sold_at > now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM public.panini_card_serials x WHERE x.sku = s.sku AND x.is_special)
      LIMIT 3) z) k
 WHERE l.confidence = 'HIGH'
   AND l.algo_version = 'panini-1.4.0'
   AND k.n < 3
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET confidence = 'MEDIUM',
       algo_version = COALESCE(fs.algo_version, '') || '_thinhigh'
  FROM public.audit_20261110_panini_thin_high_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.computed_at = b.computed_at
   AND fs.confidence = 'HIGH';

UPDATE public.edition_fmv_current c
   SET confidence = 'MEDIUM',
       refreshed_at = now()
  FROM public.audit_20261110_panini_thin_high_backup b
 WHERE c.edition_id = b.edition_id
   AND c.computed_at = b.computed_at
   AND c.confidence = 'HIGH';
