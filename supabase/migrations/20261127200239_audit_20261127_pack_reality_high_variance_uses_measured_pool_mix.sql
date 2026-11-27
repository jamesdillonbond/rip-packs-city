-- audit_20261127_pack_reality_high_variance_uses_measured_pool_mix
--
-- Trevor 2026-11-27 ("Do what you think is best"): the public Pack Reality "Honest +EV ranker" flags a
-- pack high-variance (capped value ratio, dollar figure shown as an upper bound) when its pool is >= 60 %
-- drawn. That is the same depletion-only survivor-bias rule the board, pack page and share card dropped
-- today for (a) one-edition pools — every pull is that edition — and (b) Top Shot pools whose remaining
-- mix is MEASURED to match launch (public.topshot_pool_skew, migration 20261127184627; the gate mirrors
-- lib/packs/pool-skew.ts: listed_share >= 0.95, skew < 1.5, fmv_coverage >= 0.95, pool read <= 60 d,
-- measurement <= 24 h). The coverage < 80 % and EV > 3x ask arms are unchanged.
--
-- Done in the VIEW, not the MV: v_rpc_trust_health depends on this view, so the MV cannot be dropped
-- without cascading it. The MV's own high_variance column is left as it was; the view recomputes the flag
-- from the MV's columns (same name, type and position — CREATE OR REPLACE keeps the dependents).
-- WITH (security_invoker = on) is restated so the replace does not strip it.
--
-- Revert: CREATE OR REPLACE VIEW public.topshot_pack_reality_top_ev WITH (security_invoker = on) AS
--   the same SELECT with `high_variance` (the MV column) in place of the CASE below.

CREATE OR REPLACE VIEW public.topshot_pack_reality_top_ev WITH (security_invoker = on) AS
 SELECT m.pack_listing_id,
    m.dist_id,
    m.pack_name,
    m.pack_price,
    m.gross_ev,
    m.pack_ev,
    m.value_ratio,
    m.fmv_coverage_pct,
    m.edition_count,
    m.total_unopened,
    m.depletion_pct,
    m.snapshotted_at,
    m.price_source,
    m.primary_available,
    m.secondary_available,
    ((m.fmv_coverage_pct < 80)
      OR ((COALESCE((m.depletion_pct)::integer, 0) >= 60)
          AND (m.edition_count IS DISTINCT FROM 1)
          AND NOT EXISTS (
            SELECT 1 FROM public.topshot_pool_skew s
             WHERE s.dist_id = (m.dist_id)::text
               AND s.listed_share >= 0.95
               AND s.skew < 1.5
               AND s.fmv_coverage >= 0.95
               AND s.pool_fetched_at > (now() - '60 days'::interval)
               AND s.computed_at > (now() - '24:00:00'::interval)))
      OR (m.secondary_available AND (COALESCE(m.secondary_ask, (0)::numeric) > (0)::numeric) AND (m.gross_ev > ((3)::numeric * m.secondary_ask)))) AS high_variance,
    m.is_reward_pack,
    m.retail_price_usd_normalized,
    m.secondary_ask
   FROM public.mv_topshot_pack_reality_top_ev m
  ORDER BY m.pack_ev DESC NULLS LAST;
