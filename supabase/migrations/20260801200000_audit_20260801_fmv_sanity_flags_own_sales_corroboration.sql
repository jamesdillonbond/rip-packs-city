-- v_fmv_sanity_flags produced a persistent FALSE POSITIVE (holding the
-- fmv_sanity_flags trust metric red, breach_at=1) for legitimately-cheap
-- role-player editions in star-dominated sets: it flagged any TS edition whose
-- FMV sits below 12% of its SET median FMV, but a role player (e.g. Julian
-- Champagnie 261:8714, FMV $97 in a "2026 NBA Finals" set whose median is lifted
-- to ~$815 by star editions) at 11.9% of that median is legitimate intra-set
-- dispersion, not a mispricing -- its own recent sales run $60-$215 and its FMV
-- is actually 118% of its own raw 30d median ($82).
--
-- Refinement: keep the set-median heuristic as a cheap PRE-FILTER, then require
-- CORROBORATION from the edition's own RAW recent sales (the public.sales table,
-- independent of the FMV pipeline). Fire ONLY when the FMV genuinely UNDERSTATES
-- the edition's own market -- fmv < 60% of its own 30d sales median, on >=4 sales,
-- with a >$50 absolute gap. That is the real signal for a broken/stale FMV; a
-- correctly-priced cheap role player (fmv >= own median) is excluded. This only
-- ADDS predicates to the prior output, so the flag set is a STRICT SUBSET of
-- before -- it can never introduce a new false positive, only remove the FP class.
-- Two columns appended (own_sales_median_30d, own_sales_n) so a real fire is
-- self-explaining. The sole consumer, v_rpc_trust_health, reads count(*), so the
-- appended columns are safe. security_invoker re-asserted (CREATE OR REPLACE VIEW
-- wipes reloptions). Revert: CREATE OR REPLACE back to the prior definition.
CREATE OR REPLACE VIEW public.v_fmv_sanity_flags
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT e.id AS edition_id,
    e.external_id,
    split_part(e.external_id::text, ':'::text, 1) AS set_oc,
    e.player_name,
    e.set_name,
    e.tier,
    e.circulation_count AS circ,
    f.fmv_usd,
    f.confidence
  FROM editions e
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) f ON true
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND e.thumbnail_url IS NOT NULL
    AND f.fmv_usd IS NOT NULL
    AND e.external_id::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text
), setmed AS (
  SELECT latest.set_oc,
    percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (latest.fmv_usd::double precision))
      FILTER (WHERE latest.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])) AS set_median_sales,
    count(*) FILTER (WHERE latest.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])) AS sales_n
  FROM latest
  GROUP BY latest.set_oc
), candidates AS (
  SELECT l.edition_id, l.external_id, l.player_name, l.set_name, l.tier, l.circ,
    l.fmv_usd, l.confidence,
    round(sm.set_median_sales::numeric, 2) AS set_median_sales,
    sm.sales_n,
    round((l.fmv_usd::double precision / sm.set_median_sales * 100::double precision)::numeric, 1) AS pct_of_sales_median
  FROM latest l
    JOIN setmed sm ON sm.set_oc = l.set_oc
  WHERE sm.sales_n >= 4
    AND sm.set_median_sales > 100::double precision
    AND (l.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence]))
    AND l.fmv_usd::double precision < 0.12::double precision * sm.set_median_sales
    AND (sm.set_median_sales - l.fmv_usd::double precision) > 50::double precision
)
SELECT c.edition_id,
  c.external_id,
  c.player_name,
  c.set_name,
  c.tier,
  c.circ,
  c.fmv_usd,
  c.confidence,
  c.set_median_sales,
  c.sales_n,
  c.pct_of_sales_median,
  round(own.own_median::numeric, 2) AS own_sales_median_30d,
  own.own_n AS own_sales_n
FROM candidates c
  JOIN LATERAL (
    SELECT count(*) AS own_n,
      percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision)) AS own_median
    FROM public.sales s
    WHERE s.edition_id = c.edition_id
      AND s.price_usd > 0::numeric
      AND s.sold_at >= (now() - interval '30 days')
  ) own ON true
WHERE own.own_n >= 4
  AND c.fmv_usd::double precision < 0.6::double precision * own.own_median
  AND (own.own_median - c.fmv_usd::double precision) > 50::double precision
ORDER BY (own.own_median - c.fmv_usd::double precision) DESC;

REVOKE SELECT ON public.v_fmv_sanity_flags FROM anon, authenticated;
GRANT SELECT ON public.v_fmv_sanity_flags TO service_role, postgres;
