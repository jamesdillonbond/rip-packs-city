-- Candy pack-EV model (Drop 3, $10 pack = 10 ICONs + 15% Rainbow-variant chance). Mirrors
-- panini_pack_ev_model: supply-weighted per-tier, reporting Actual EV (chase-inclusive MEAN) and
-- Typical Pull (MEDIAN — the median pack pulls no Rainbow). HONESTY: the Rainbow leg is largely UNPRICED
-- (2/25), secondary is ultra-thin, all FMV is LOW-confidence, and Drop 3 dumps forward supply — so the
-- board MUST lead with Typical Pull and carry an illiquidity/forward-supply caveat. security_invoker;
-- anon/authenticated REVOKED. Single-row summary.
-- Applied live via MCP; this file is for repo/rebuild parity (re-applying is harmless).
-- Revert: DROP VIEW public.candy_pack_ev_model;
CREATE OR REPLACE VIEW public.candy_pack_ev_model
WITH (security_invoker = true) AS
WITH ed AS (
  SELECT e.tier, e.circulation_count AS circ, fc.fmv_usd AS fmv
  FROM public.editions e
  LEFT JOIN public.fmv_current fc ON fc.edition_id = e.id
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
),
agg AS (
  SELECT tier,
    count(*)                                                         AS total,
    count(*) FILTER (WHERE fmv IS NOT NULL AND fmv > 0)              AS priced,
    (sum(fmv * circ) FILTER (WHERE fmv IS NOT NULL)
       / NULLIF(sum(circ) FILTER (WHERE fmv IS NOT NULL), 0))::numeric AS sw_mean,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY fmv::double precision)
       FILTER (WHERE fmv IS NOT NULL AND fmv > 0))::numeric          AS med
  FROM ed
  GROUP BY tier
),
p AS (
  SELECT
    max(sw_mean) FILTER (WHERE tier='COMMON')    AS common_sw,
    max(med)     FILTER (WHERE tier='COMMON')    AS common_med,
    max(total)   FILTER (WHERE tier='COMMON')    AS common_total,
    max(priced)  FILTER (WHERE tier='COMMON')    AS common_priced,
    max(sw_mean) FILTER (WHERE tier='LEGENDARY') AS rainbow_sw,
    max(med)     FILTER (WHERE tier='LEGENDARY') AS rainbow_med,
    max(total)   FILTER (WHERE tier='LEGENDARY') AS rainbow_total,
    max(priced)  FILTER (WHERE tier='LEGENDARY') AS rainbow_priced
  FROM agg
)
SELECT
  10::int      AS icon_slots,
  0.15::numeric AS rainbow_chance,
  10::numeric  AS pack_cost_usd,
  round(common_sw, 2)                                      AS common_slot_ev,
  round(common_med, 2)                                     AS common_slot_typical,
  round(rainbow_sw, 2)                                     AS rainbow_ev,
  common_total, common_priced, rainbow_total, rainbow_priced,
  round(10 * common_sw + 0.15 * COALESCE(rainbow_sw, 0), 2) AS actual_ev_usd,
  round(10 * common_med, 2)                                AS typical_pull_ev_usd,
  ('candy-pack-ev-0.1 · $10 pack = 10 ICONs + 15% Rainbow chance · supply-weighted · '
   || 'Actual EV = chase-inclusive MEAN; Typical Pull = 10 × median common (the median pack pulls no Rainbow) · '
   || 'Rainbow leg largely UNPRICED (' || COALESCE(rainbow_priced,0) || '/' || COALESCE(rainbow_total,0) || '), commons '
   || COALESCE(common_priced,0) || '/' || COALESCE(common_total,0) || ' priced · secondary market ultra-thin + all FMV '
   || 'LOW-confidence + Drop 3 adds forward supply → indicative pull value, NOT liquidation value')::text AS model_note
FROM p;

REVOKE ALL ON public.candy_pack_ev_model FROM anon, authenticated;
GRANT SELECT ON public.candy_pack_ev_model TO service_role;
