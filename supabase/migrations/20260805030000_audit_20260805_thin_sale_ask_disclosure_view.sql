-- 2026-08-04 PT · The DISCLOSURE cohort for disconnected asks the clamp deliberately
-- will not touch. Trevor delegated the call; this view is the canonical population.
--
-- WHY A VIEW AND NOT A HARDCODED QUERY IN THE PAGE: the population is defined as
-- "fmv_clamp_disconnected_ask's own predicate with ONE term swapped" --
-- n_real >= 5 becomes n_real BETWEEN 1 AND 4. Everything else is verbatim. If the
-- clamp's thresholds ever move and a page carried its own copy, the disclosure would
-- silently stop describing the same editions the clamp skips. Keep them adjacent.
--
-- ⚠ THE BINDING PRODUCT RULE: NEVER render a range or a "fair value" for these rows.
-- Clamping a circ-5 grail off 2 sales fabricates a LOW price, which is a worse lie
-- than the high ask. This cohort gets DISCLOSURE ONLY -- the ask, the real last sale
-- (however old), and the 90d sale count. Do not widen n_real >= 5 to "fix" it.
--
-- ⚠ last_sale_* is the last sale EVER, not the last sale in the 90d window. The
-- staleness is the information: "last sold $650 on May 15" is the disclosure working.
--
-- ⚠ BATCH-ONLY, NOT A REQUEST-PATH VIEW. Measured at creation: full scan 28.8s /
-- 1.26M buffers. The DISTINCT ON over fmv_snapshots evaluates BEFORE any edition
-- filter (985,516 rows of fmv_snapshots_2026 scanned, 922k buffers), so a per-edition
-- `WHERE edition_id = $1` does NOT push down and does NOT get cheaper. Use this for
-- board suppression, audits and precompute. A moment/edition page needs a separate
-- per-edition fast path (filter fmv_snapshots by edition_id FIRST) or a small
-- precomputed table refreshed on cron -- do NOT wire a page straight to this view.
--
-- Verified at creation (2026-08-04 PT): 234 rows · $79,974.14 published FMV ·
-- $57,078.03 above the clamp line · 78 at circulation 1-49 · n_real 1:135 2:56 3-4:44.
-- The population drifts as sales land and fmv-recalc sweeps (the handoff measured 237,
-- then 239, on earlier days) -- treat the SHAPE as stable, never the exact count.
--
-- REVERT: DROP VIEW public.v_fmv_thin_sale_ask_disclosure;

CREATE OR REPLACE VIEW public.v_fmv_thin_sale_ask_disclosure AS
WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id)
         fs.edition_id, fs.collection_id, fs.fmv_usd, fs.confidence, fs.computed_at,
         fs.top_shot_ask, fs.flowty_ask, fs.cross_market_ask
  FROM public.fmv_snapshots fs
  WHERE fs.collection_id <> '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
  ORDER BY fs.edition_id, fs.computed_at DESC
), s90 AS (
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
FROM latest l
JOIN s90 s              ON s.edition_id = l.edition_id
JOIN public.editions e  ON e.id = l.edition_id
LEFT JOIN LATERAL (
  -- last sale EVER (not window-bounded) -- rule 2: the staleness is the information
  SELECT s2.price_usd, s2.sold_at
  FROM public.sales s2
  WHERE s2.edition_id = l.edition_id AND s2.price_usd > 0.10
  ORDER BY s2.sold_at DESC
  LIMIT 1
) ls ON true
WHERE l.confidence IN ('LOW','ASK_ONLY')
  AND s.n_real BETWEEN 1 AND 4          -- <<< the ONE swapped term vs the clamp
  AND s.p90 > 0
  AND l.fmv_usd > s.med * 3
  AND l.fmv_usd > s.p90 * 1.5
  AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2);

-- ⚠ CREATE OR REPLACE VIEW drops reloptions -- re-set security_invoker every time.
ALTER VIEW public.v_fmv_thin_sale_ask_disclosure SET (security_invoker = on);

-- Route-gating is not data-gating: revoke the default anon/authenticated grant.
-- Read it server-side via supabaseAdmin. Verified after apply:
--   has_table_privilege anon=false, authenticated=false, service_role=true.
REVOKE SELECT ON public.v_fmv_thin_sale_ask_disclosure FROM anon, authenticated;

COMMENT ON VIEW public.v_fmv_thin_sale_ask_disclosure IS
  'Disconnected-ask editions with 1-4 real sales in 90d -- the cohort fmv_clamp_disconnected_ask deliberately SKIPS (it requires n_real >= 5). DISCLOSURE ONLY: render the ask, the real last sale however old, and the 90d count. NEVER render a range or a fair value for these, and never widen the clamp to cover them -- clamping off 1-4 sales fabricates a low price. Suppress these editions from ranked/sorted boards entirely rather than ranking them with a caveat. ⚠ BATCH-ONLY, NOT A REQUEST-PATH VIEW: measured 2026-08-04 at 28.8s / 1.26M buffers for a full scan, because the DISTINCT ON over fmv_snapshots evaluates before any edition filter, so a per-edition WHERE does NOT push down. Use it for board suppression, audits and precompute; a moment/edition page needs a separate per-edition fast path (filter fmv_snapshots by edition_id FIRST) or a precomputed table refreshed on cron.';
