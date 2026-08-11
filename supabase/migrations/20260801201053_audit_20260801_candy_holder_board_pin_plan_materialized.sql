-- FOLLOW-UP to audit_20260801_candy_holder_board_scope_fmv_join.
-- Scoping the FMV join fixed the 944k-row DISTINCT ON, but the view was still
-- PLAN-UNSTABLE: `... ORDER BY est_fmv_usd DESC LIMIT 50` ran in 2.9s while the
-- live page's `SELECT * ... LIMIT 200` (no ORDER BY) still TIMED OUT — a bare LIMIT
-- makes the planner pick a cheap-startup plan that re-drives the treasury InitPlan
-- and the wmc lookup instead of aggregating once. So the Holders tab on the LIVE
-- public /insights/candy-mlb board was still rendering "Holders 0" against 373
-- real collectors (verified by rendered-DOM QA after the first fix).
--
-- Fix: pin the plan with MATERIALIZED CTEs so the treasury wallet is resolved
-- exactly once and the per-wallet aggregate is completed before any LIMIT is
-- applied. Output columns byte-identical.
CREATE OR REPLACE VIEW public.candy_holder_board AS
WITH treas AS MATERIALIZED (
  SELECT wallet_address
    FROM wallet_moments_cache
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
   GROUP BY wallet_address
   ORDER BY count(*) DESC
   LIMIT 1
), cfmv AS MATERIALIZED (
  -- scoped to the Candy slice (125 editions), not the 944k-row global DISTINCT ON
  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
    FROM fmv_snapshots
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
   ORDER BY edition_id, computed_at DESC
), ed AS MATERIALIZED (
  SELECT e.id AS edition_id, e.external_id::text AS edition_key
    FROM editions e
   WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
), agg AS MATERIALIZED (
  SELECT w.wallet_address,
         count(*)                                        AS serials,
         count(DISTINCT w.edition_key)                   AS editions,
         round(sum(c.fmv_usd), 2)                        AS est_fmv_usd,
         count(*) FILTER (WHERE c.fmv_usd IS NOT NULL)   AS priced_serials
    FROM wallet_moments_cache w
    JOIN ed        ON ed.edition_key = w.edition_key
    LEFT JOIN cfmv c ON c.edition_id = ed.edition_id
   WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.wallet_address <> (SELECT wallet_address FROM treas)
   GROUP BY w.wallet_address
)
SELECT wallet_address, serials, editions, est_fmv_usd, priced_serials FROM agg;

ALTER VIEW public.candy_holder_board SET (security_invoker = on);
REVOKE SELECT ON public.candy_holder_board FROM anon, authenticated;