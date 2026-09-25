-- 2026-09-25 (PT) — fmv-recalc's historical fallback (Step 5b) priced a cold
-- edition at its ALL-TIME MEAN sale price, and leap-frogged the cold-tail
-- drain's last-30-sales MEDIAN every week.
--
-- WHY. Two writers own the "no snapshot for 7 days, no sale for 30" population:
-- `fmv_recalc_historical_candidates` (this function → Step 5b, algo 1.7.0)
-- returned AVG(price_usd) over EVERY sale the edition ever had, and
-- `drain_fmv_cold_tail` (algo cold-tail-1.0) prices the same edition at the
-- median of its last 30 sales. Each treats the other's row as fresh for 7 days,
-- then re-prices with its own number, so the published FMV alternated weekly —
-- David García Talentos (Golazos 354): $3.32 → $1.00 → $3.32 → $1.00 with no
-- sale in 1,070 days, and the edition page printed "24H CHANGE +232%". Measured
-- 6:55 AM PT over 21 days: 1,012 editions carry both writers' STALE rows, 797
-- with DIFFERENT values; 1.7.0's value IS the all-time mean (917/1,012) and
-- cold-tail's IS the last-30 median (928/1,012); median ratio mean/median
-- 1.69× on UFC (p90 6.1×, ~1,942 sales each — the 2022 prices still in the
-- mean), 1.35× on Golazos (p90 2.9×). An all-time mean is not a price: it is
-- dominated by the hype years and cannot fall as the market does.
--
-- WHAT. The candidate query returns, per edition, the MEDIAN and MIN of its
-- LAST 30 paid sales (count ≤ 30, latest sold_at) — the same estimator the
-- cold-tail drain writes — so the two writers agree, the weekly flip stops,
-- and the STALE price reflects the most recent trading. Column NAMES are
-- unchanged (`avg_price` now carries the median; the route reads it as "the
-- sales-derived price" and labels rows STALE / SALES_ONLY by count, which
-- still works at ≤ 30). Candidate selection, the ULTIMATE / Pinnacle
-- exclusions, the ask join and the ACL are untouched. The badge_editions join
-- moves off the sales aggregate so a second badge row can no longer weight it.
-- Revert: re-apply 20260905040111 (the AVG-over-all-sales body).

-- anon-exec: intentional — fmv_recalc_historical_candidates stays service_role-only (ACL unchanged by CREATE OR REPLACE; REVOKEd from PUBLIC, anon, authenticated in 20260905040111).
CREATE OR REPLACE FUNCTION public.fmv_recalc_historical_candidates(
  p_pinnacle_collection_id uuid,
  p_stale_after interval DEFAULT '7 days',
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  edition_id      uuid,
  collection_id   uuid,
  avg_price       numeric,
  min_price       numeric,
  sales_count     bigint,
  latest_sold_at  timestamptz,
  prev_confidence text,
  low_ask         numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout TO '60s'
SET search_path TO 'public'
AS $function$
  WITH stale AS MATERIALIZED (
    -- The SELECTIVE half, alone. 7,224 of 26,722 survive here today.
    SELECT e.id, e.collection_id, e.external_id, la.confidence::text AS prev_confidence
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fs.edition_id, fs.confidence, fs.computed_at
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) la ON true
    WHERE (la.edition_id IS NULL
           OR la.confidence = 'NO_DATA'
           OR la.computed_at < now() - p_stale_after)
      AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
      AND e.collection_id <> p_pinnacle_collection_id
  ),
  cand AS (
    -- The non-selective half, now paid only for survivors -- and the LIMIT stays
    -- AFTER it, so zero-paid-sale editions can never squat the candidate set.
    SELECT s.id, s.collection_id, s.external_id, s.prev_confidence
    FROM stale s
    WHERE EXISTS (
      SELECT 1 FROM sales sa WHERE sa.edition_id = s.id AND sa.price_usd > 0
    )
    LIMIT p_limit
  )
  SELECT
    c.id,
    c.collection_id,
    -- 2026-09-25: MEDIAN and MIN of the LAST 30 paid sales — the estimator
    -- drain_fmv_cold_tail writes for the same population — never the all-time
    -- mean (see the header). `avg_price` keeps its name for the route.
    h.med::numeric,
    h.mn::numeric,
    h.n,
    h.last_sold,
    c.prev_confidence,
    (SELECT MAX(be.low_ask) FROM badge_editions be
      WHERE be.external_id = c.external_id AND be.collection_id = c.collection_id
        AND be.low_ask > 0 AND be.low_ask <= 10000)
  FROM cand c
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.price_usd) AS med,
           MIN(r.price_usd) AS mn,
           COUNT(*)         AS n,
           MAX(r.sold_at)   AS last_sold
    FROM (
      SELECT s.price_usd, s.sold_at
      FROM sales s
      WHERE s.edition_id = c.id AND s.price_usd > 0
      ORDER BY s.sold_at DESC
      LIMIT 30
    ) r
  ) h
  WHERE h.n > 0;
$function$;

REVOKE ALL ON FUNCTION public.fmv_recalc_historical_candidates(uuid, interval, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_recalc_historical_candidates(uuid, interval, integer)
  TO service_role;

COMMENT ON FUNCTION public.fmv_recalc_historical_candidates(uuid, interval, integer) IS
  'fmv-recalc Step 5b candidates: editions with no snapshot for p_stale_after '
  '(or NO_DATA), excluding ULTIMATE and Pinnacle, that have at least one paid '
  'sale. avg_price/min_price/sales_count/latest_sold_at describe the LAST 30 '
  'paid sales (median, min, count, latest) — the same estimator '
  'drain_fmv_cold_tail uses, so the two cold-population writers agree '
  '(2026-09-25). low_ask is the best current TS ask from badge_editions.';

-- Post-condition: every candidate row is the last-30 median, independently
-- recomputed, with a count of at most 30 — on a 0-day staleness sample so the
-- check has a population to inspect.
DO $$
DECLARE v_bad int; v_n int;
BEGIN
  SELECT count(*), count(*) FILTER (
    WHERE r.sales_count > 30
       OR abs(r.avg_price - (
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd)
            FROM (SELECT s.price_usd FROM public.sales s WHERE s.edition_id = r.edition_id AND s.price_usd > 0
                  ORDER BY s.sold_at DESC LIMIT 30) q)) > 0.005)
  INTO v_n, v_bad
  FROM public.fmv_recalc_historical_candidates('7dd9dd11-e8b6-45c4-ac99-71331f959714', '0 days', 60) r;
  IF v_n = 0 THEN RAISE NOTICE 'no candidates to check at 0 days (unexpected but not an error)'; END IF;
  IF v_bad <> 0 THEN RAISE EXCEPTION '% of % candidate rows are not the last-30 median', v_bad, v_n; END IF;
END $$;
