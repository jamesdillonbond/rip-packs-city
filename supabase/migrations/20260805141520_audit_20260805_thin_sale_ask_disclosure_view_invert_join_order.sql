-- 2026-08-05 · Restructure v_fmv_thin_sale_ask_disclosure per handoff §1 (Cowork).
--
-- WHAT WAS WRONG: the `latest` CTE was a DISTINCT ON over ALL of fmv_snapshots --
-- measured Merge Append over 986,708 rows just to keep one row per edition -- and it
-- evaluated before any edition filter, so the refresher could not finish inside 600s.
--
-- THE FIX: invert the join order. Compute the 90-day sales aggregate FIRST, filter to
-- n_real BETWEEN 1 AND 4 (the swapped term), then fetch the latest snapshot for each
-- SURVIVING edition via LATERAL ... ORDER BY computed_at DESC LIMIT 1. That turns the
-- 986,708-row dedupe into a few thousand per-edition index seeks on
-- fmv_snapshots_<year>_edition_id_computed_at_idx.
--
-- ⚠ BOTH CTEs ARE `AS MATERIALIZED` AND THAT IS LOAD-BEARING. Without it the planner
-- inlines s90, decides it wants edition_id-sorted output to feed the nested loop, and
-- switches to a FULL ordered Index Scan on sales_2026_edition_id_sold_at_idx --
-- sold_at is the SECOND column of that index so it cannot seek, and it reads all
-- 353,073 entries. MATERIALIZED forces the aggregate to stand alone as a parallel seq
-- scan + hash aggregate, which is what it should be. Measured plan-flip during this
-- change; do not remove MATERIALIZED to "simplify".
--
-- ⚠ STILL BATCH-ONLY -- this is NOT now a request-path view. The s90 aggregate alone
-- measures 19.7s / 33,610 buffers (28,125 read from disk), because NO sales partition
-- carries an unconditional sold_at-leading index -- all of them are partial. That cost
-- is irreducible by query restructuring. The remaining lever is an index, deliberately
-- NOT taken here: a plain CREATE INDEX takes ACCESS EXCLUSIVE on a hot ingest
-- partition and CONCURRENTLY cannot run inside apply_migration. See the handoff.
--
-- EQUIVALENCE: the predicate is unchanged term for term. The only semantic care point
-- is that `latest` used an INNER JOIN to s90, so editions with sales but no snapshot
-- were dropped -- CROSS JOIN LATERAL (not LEFT) preserves exactly that. collection_id
-- is a property of the edition, so hoisting the Pinnacle exclusion into the LATERAL
-- cannot change which snapshot wins.
--
-- REVERT: re-apply audit_20260805_thin_sale_ask_disclosure_view (the DISTINCT ON form).

CREATE OR REPLACE VIEW public.v_fmv_thin_sale_ask_disclosure AS
WITH s90 AS MATERIALIZED (
  SELECT s.edition_id,
         count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd)
           FILTER (WHERE s.price_usd > 0.10) AS p90,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)
           FILTER (WHERE s.price_usd > 0.10) AS med
  FROM public.sales s
  WHERE s.collection_id <> '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
    AND s.sold_at >= now() - interval '90 days'
  GROUP BY s.edition_id
), cand AS MATERIALIZED (
  SELECT * FROM s90
  WHERE n_real BETWEEN 1 AND 4          -- <<< the ONE swapped term vs the clamp
    AND p90 > 0
)
SELECT
  l.edition_id,
  l.collection_id,
  e.external_id,
  e.name                                                   AS edition_name,
  e.circulation_count,
  l.confidence,
  l.fmv_usd                                                AS published_fmv_usd,
  COALESCE(l.top_shot_ask, l.flowty_ask, l.cross_market_ask) AS ask_usd,
  s.n_real                                                 AS sales_90d,
  ROUND(s.med::numeric, 2)                                 AS median_90d_usd,
  ROUND(s.p90::numeric, 2)                                 AS p90_90d_usd,
  ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)          AS clamp_line_usd,
  ROUND((l.fmv_usd - GREATEST(s.p90 * 1.5, s.med))::numeric, 2) AS dollars_above_clamp_usd,
  ls.price_usd                                             AS last_sale_usd,
  ls.sold_at                                               AS last_sale_at,
  l.computed_at                                            AS fmv_computed_at
FROM cand s
JOIN public.editions e ON e.id = s.edition_id
CROSS JOIN LATERAL (
  -- latest snapshot for THIS edition only -- replaces the whole-table DISTINCT ON
  SELECT fs.edition_id, fs.collection_id, fs.fmv_usd, fs.confidence, fs.computed_at,
         fs.top_shot_ask, fs.flowty_ask, fs.cross_market_ask
  FROM public.fmv_snapshots fs
  WHERE fs.edition_id = s.edition_id
    AND fs.collection_id <> '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
  ORDER BY fs.computed_at DESC
  LIMIT 1
) l
LEFT JOIN LATERAL (
  -- last sale EVER (not window-bounded) -- rule 2: the staleness is the information
  SELECT s2.price_usd, s2.sold_at
  FROM public.sales s2
  WHERE s2.edition_id = s.edition_id AND s2.price_usd > 0.10
  ORDER BY s2.sold_at DESC
  LIMIT 1
) ls ON true
WHERE l.confidence IN ('LOW','ASK_ONLY')
  AND l.fmv_usd > s.med * 3
  AND l.fmv_usd > s.p90 * 1.5
  AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2);

-- ⚠ CREATE OR REPLACE VIEW drops reloptions -- re-set security_invoker every time.
ALTER VIEW public.v_fmv_thin_sale_ask_disclosure SET (security_invoker = on);
REVOKE SELECT ON public.v_fmv_thin_sale_ask_disclosure FROM anon, authenticated;

COMMENT ON VIEW public.v_fmv_thin_sale_ask_disclosure IS
  'Disconnected-ask editions with 1-4 real sales in 90d -- the cohort fmv_clamp_disconnected_ask deliberately SKIPS (it requires n_real >= 5). DISCLOSURE ONLY: render the ask, the real last sale however old, and the 90d count. NEVER render a range or a fair value for these, and never widen the clamp to cover them -- clamping off 1-4 sales fabricates a low price. Suppress these editions from ranked/sorted boards entirely rather than ranking them with a caveat. STRUCTURE (2026-08-05): the 90d sales aggregate is computed FIRST and filtered to n_real 1-4, then the latest snapshot is fetched per surviving edition via LATERAL -- this replaced a DISTINCT ON over all 986,708 fmv_snapshots rows that could not finish inside 600s. Both CTEs are AS MATERIALIZED and that is LOAD-BEARING: without it the planner switches s90 to a full ordered index scan on (edition_id, sold_at), whose sold_at is the second column and cannot seek. STILL BATCH-ONLY, NOT REQUEST-PATH: the s90 aggregate alone is 19.7s / 28,125 disk reads because no sales partition has an unconditional sold_at-leading index (all are partial). Read it through fmv_thin_sale_ask_disclosure_cache, and always check that table refreshed_at before rendering.';

DROP VIEW IF EXISTS public.v_fmv_thin_sale_ask_disclosure_v2;
