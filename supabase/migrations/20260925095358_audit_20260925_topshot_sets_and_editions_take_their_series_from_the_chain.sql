-- 2026-09-25 (PT) — known-issues #137(h): the writer that creates Top Shot
-- sets and editions with `series` NULL is `catalog_topshot_from_atlas` — it
-- inserts `sets.series` as NULL by construction (Atlas' badge_editions carries
-- no series, and its `series_number` is read back FROM editions, circularly),
-- and the editions it creates under those sets inherit the gap. 14 Top Shot
-- sets carried NULL: 9 are empty legacy rows with no on-chain id (inert,
-- untouched); 5 have an on-chain set id, and the chain knows their series —
-- `TopShot.getSetSeries(setID)` read through Flow REST at 3:10 AM PT 09-25:
--   140 → 6 (Series 2023-24) · 253, 275, 278, 279 → 8 (Series 2025-26)
-- (the DB stores the on-chain UInt32 verbatim: 0 and 1 are both real values).
-- The 154 NULL-series editions all sit under sets 253 / 275 / 277 / 278 / 279
-- (277 "WNBA Hustle & Show" already carried 8); they take their set's series.
--
-- Durable half: the daily route /api/cron/topshot-set-series-onchain reads
-- `getSetSeries` for any Top Shot set still NULL and fills its editions.
-- Revert: pre-images in audit_20260925_ts_set_series_backup (drop after 10-01).

CREATE TABLE IF NOT EXISTS public.audit_20260925_ts_set_series_backup AS
SELECT 'set'::text AS kind, s.id, s.set_id_onchain, s.series
FROM public.sets s
WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND s.series IS NULL AND s.set_id_onchain IS NOT NULL
UNION ALL
SELECT 'edition', e.id, e.set_id_onchain, e.series
FROM public.editions e
WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.series IS NULL;
ALTER TABLE public.audit_20260925_ts_set_series_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_ts_set_series_backup FROM PUBLIC, anon, authenticated;

WITH chain(set_id_onchain, series) AS (VALUES (140, 6), (253, 8), (275, 8), (278, 8), (279, 8))
UPDATE public.sets s
   SET series = c.series
  FROM chain c
 WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND s.set_id_onchain = c.set_id_onchain
   AND s.series IS NULL;

UPDATE public.editions e
   SET series = s.series
  FROM public.sets s
 WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND e.series IS NULL
   AND s.collection_id = e.collection_id
   AND s.set_id_onchain = e.set_id_onchain
   AND s.series IS NOT NULL;

DO $$
DECLARE v_sets int; v_eds int;
BEGIN
  SELECT count(*) INTO v_sets FROM public.sets WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND series IS NULL AND set_id_onchain IS NOT NULL;
  SELECT count(*) INTO v_eds FROM public.editions WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND series IS NULL;
  IF v_sets <> 0 THEN RAISE EXCEPTION '% Top Shot sets with an on-chain id still have no series', v_sets; END IF;
  IF v_eds <> 0 THEN RAISE EXCEPTION '% Top Shot editions still have no series', v_eds; END IF;
END $$;
