-- SHADOW view. Computes what Top Shot pack EV WOULD be under tier-scaled remaining,
-- alongside the live value, so the change can be diffed before any published number
-- moves. Nothing consumes this; it changes no user-facing output.
--
-- METHOD: for edition e in tier T of a dist,
--   w_e = orig_drop_weight_e * (remaining_by_tier[T] / original_by_tier[T])
-- normalized, then weighted-mean FMV * slots (the same shape as gross_ev).
-- VALIDATED 2026-07-31 on 423 multi-tier TS dists with true per-edition remaining:
--   mean abs error vs truth  ->  original-supply 101.5%  |  tier-scaled 26.8%
--   tier-scaled closer on 299/423 (70.7%)
-- ONLY meaningful where is_multi_tier: on single-tier dists it collapses to a
-- uniform rescale of the original weights (a no-op) and must not be applied.
--
-- Analysis-only: it scans pack_drop_pool + fmv_current, so do not put it on a hot path.
-- REVERT: DROP VIEW IF EXISTS public.v_topshot_pack_ev_tier_scaled;
CREATE OR REPLACE VIEW public.v_topshot_pack_ev_tier_scaled AS
WITH slots AS (
  SELECT dist_id,
         NULLIF(metadata ->> 'number_of_pack_slots', '')::int AS pack_slots
    FROM public.pack_distributions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
),
w AS (
  SELECT p.dist_id,
         p.drop_weight,
         p.orig_drop_weight,
         f.fmv_usd,
         COALESCE((s.remaining_by_tier ->> lower(e.tier::text))::numeric, 0)      AS rem_t,
         NULLIF(COALESCE((s.original_by_tier ->> lower(e.tier::text))::numeric, 0), 0) AS orig_t
    FROM public.pack_drop_pool p
    JOIN public.editions e            ON e.id = p.edition_id
    JOIN public.fmv_current f         ON f.edition_id = p.edition_id
    JOIN public.topshot_pack_supply s ON s.dist_id = p.dist_id
   WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND p.orig_drop_weight IS NOT NULL
     AND f.fmv_usd IS NOT NULL
),
agg AS (
  SELECT dist_id,
         count(*)                                                              AS priced_editions,
         sum(drop_weight * fmv_usd) / NULLIF(sum(drop_weight), 0)              AS live_mean_fmv,
         sum(orig_drop_weight * (rem_t / orig_t) * fmv_usd)
           / NULLIF(sum(orig_drop_weight * (rem_t / orig_t)), 0)               AS tier_scaled_mean_fmv
    FROM w
   GROUP BY dist_id
)
SELECT b.dist_id,
       b.title,
       b.remaining_basis,
       b.remaining_trustworthy,
       b.is_multi_tier,
       b.total_sealed,
       sl.pack_slots,
       a.priced_editions,
       ev.gross_ev                                             AS live_gross_ev,
       round(a.live_mean_fmv, 4)                               AS live_mean_fmv,
       round(a.tier_scaled_mean_fmv, 4)                         AS tier_scaled_mean_fmv,
       round(a.tier_scaled_mean_fmv * sl.pack_slots, 2)         AS tier_scaled_gross_ev,
       round(a.tier_scaled_mean_fmv * sl.pack_slots - ev.gross_ev, 2) AS delta_vs_live,
       CASE WHEN ev.gross_ev > 0
            THEN round(a.tier_scaled_mean_fmv * sl.pack_slots / ev.gross_ev, 3)
       END                                                      AS ratio_vs_live,
       -- Safe to apply only where the pool exists AND the publisher reports 2+ tiers.
       (b.is_multi_tier AND b.remaining_basis IN
          ('original_supply_mislabelled', 'placeholder_uniform')) AS is_candidate
  FROM public.v_pack_remaining_basis b
  JOIN agg a  ON a.dist_id = b.dist_id
  LEFT JOIN slots sl ON sl.dist_id = b.dist_id
  LEFT JOIN public.pack_ev_latest ev
         ON ev.dist_id = b.dist_id
        AND ev.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
 WHERE b.collection = 'nba_top_shot';

ALTER VIEW public.v_topshot_pack_ev_tier_scaled SET (security_invoker = on);
REVOKE ALL ON public.v_topshot_pack_ev_tier_scaled FROM anon, authenticated;
GRANT SELECT ON public.v_topshot_pack_ev_tier_scaled TO service_role;

COMMENT ON VIEW public.v_topshot_pack_ev_tier_scaled IS
'SHADOW/analysis view: what Top Shot pack EV would be under tier-scaled remaining, beside the live value. Consumed by nothing; publishes nothing. Apply only where is_candidate (multi-tier AND the pool is original-basis) - on single-tier dists tier-scaling is a no-op. Validated 2026-07-31: 101.5% -> 26.8% mean abs error vs true per-edition remaining on 423 multi-tier dists. See docs/overnight/ledger.md.';