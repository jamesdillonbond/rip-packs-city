-- Pre-ship baseline for the DUST_PRICE_USD ($0.50 absolute sale floor) removal
-- from dampenGrailSpike() in lib/fmv-recalc-math.ts (decision doc:
-- docs/fmv-dust-filter-decision-2026-08-02.md, Option A).
--
-- Captures the PUBLISHED FMV state immediately before the code change, plus each
-- edition's own UNFILTERED realized 30d sales median (the accuracy benchmark), so
-- the direction of change can be proven afterwards and prior FMVs restored if needed.
--
-- Pinnacle is excluded on purpose: it is render-keyed in pinnacle_fmv_history and
-- fmv-recalc explicitly .neq()s it, so this code path never prices it.
--
-- REVERT: DROP TABLE IF EXISTS public.fmv_dust_removal_baseline_20260802;
CREATE TABLE IF NOT EXISTS public.fmv_dust_removal_baseline_20260802 (
  edition_id           uuid PRIMARY KEY,
  collection_id        uuid NOT NULL,
  collection_slug      text,
  fmv_usd              numeric,
  floor_price_usd      numeric,
  confidence           text,
  algo_version         text,
  sales_count_30d      integer,
  computed_at          timestamptz,
  own_median_30d       numeric,   -- unfiltered median of ALL 30d sales (the benchmark)
  own_sales_30d        integer,   -- true unfiltered 30d sale count
  own_sales_sub_50c    integer,   -- how many of those the dust floor discarded
  captured_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.fmv_dust_removal_baseline_20260802 (
  edition_id, collection_id, collection_slug, fmv_usd, floor_price_usd, confidence,
  algo_version, sales_count_30d, computed_at, own_median_30d, own_sales_30d, own_sales_sub_50c
)
WITH own AS (
  SELECT s.edition_id,
         s.collection_id,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)::numeric AS med,
         count(*)::int                                                     AS n,
         count(*) FILTER (WHERE s.price_usd < 0.5)::int                    AS n_dust
  FROM public.sales s
  WHERE s.sold_at >= now() - interval '30 days'
    AND s.price_usd > 0
    AND s.edition_id IS NOT NULL
  GROUP BY 1, 2
)
SELECT COALESCE(f.edition_id, own.edition_id),
       COALESCE(f.collection_id, own.collection_id),
       c.slug,
       f.fmv_usd, f.floor_price_usd, f.confidence::text, f.algo_version,
       f.sales_count_30d, f.computed_at,
       own.med, own.n, own.n_dust
FROM public.fmv_current f
FULL OUTER JOIN own ON own.edition_id = f.edition_id
LEFT JOIN public.collections c
  ON c.id = COALESCE(f.collection_id, own.collection_id)
WHERE COALESCE(f.collection_id, own.collection_id)
      <> '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid  -- Pinnacle: separate pricing plane
ON CONFLICT (edition_id) DO NOTHING;

ALTER TABLE public.fmv_dust_removal_baseline_20260802 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmv_dust_removal_baseline_20260802 FROM anon, authenticated;
REVOKE ALL ON public.fmv_dust_removal_baseline_20260802 FROM PUBLIC;
GRANT ALL ON public.fmv_dust_removal_baseline_20260802 TO service_role;

CREATE INDEX IF NOT EXISTS idx_fmv_dust_baseline_collection
  ON public.fmv_dust_removal_baseline_20260802 (collection_id);

COMMENT ON TABLE public.fmv_dust_removal_baseline_20260802 IS
  'Pre-ship FMV baseline for the 2026-08-02 removal of the $0.50 absolute dust floor from dampenGrailSpike(). Revert reference + proof-of-improvement benchmark. Safe to DROP once the change has soaked.';