-- audit_20260802_offers_open_edition_rollup_covering_index
-- Partial covering index for the v_offer_sanity_flags `onchain` rollup, which backs the
-- offer_edition_gap_max_usd arm of v_rpc_trust_health.
--
-- WHY: that CTE groups the 23,672 open TopShot offers by edition_id and aggregates
-- offer_amount_usd / offer_type / created_at. The existing idx_offers_status_edition
-- (collection_id, status, edition_id) carries NONE of those payload columns, so the plan
-- heap-fetched every matching row and then Incremental Sort'ed -- 24,533 buffers (~191MB of
-- buffer traffic against a 28MB table) and, under the IOPS throttle observed 2026-08-02,
-- 24-49s for what is 68ms warm.
--
-- This index is ALREADY ORDERED by (collection_id, edition_id), so the GroupAggregate needs
-- no sort at all, and INCLUDE covers all three aggregated columns so the scan can go
-- index-only. Precondition validated before building (per the fmv_current counter-case):
-- offers is 89.2% all-visible (relallvisible 3244 / relpages 3636), so index-only genuinely
-- engages rather than degrading back into heap fetches.
--
-- Partial on status='open' keeps it to 23,672 of 107,110 rows (~1-2MB), so the write cost on
-- the 20-min offers sweep is negligible. Predicate is written as status::text = 'open'::text
-- to match the view's own expression exactly so the planner can prove implication.
--
-- Built NON-CONCURRENTLY on purpose: the table is 28MB and the concurrent build (two passes
-- + waits) exceeded the 120s session ceiling under throttle, while the single-pass build
-- takes a brief SHARE lock that the 20-min offers sweep tolerates.
--
-- REVERT: DROP INDEX IF EXISTS public.idx_offers_open_edition_rollup;

CREATE INDEX IF NOT EXISTS idx_offers_open_edition_rollup
ON public.offers (collection_id, edition_id)
INCLUDE (offer_amount_usd, offer_type, created_at)
WHERE (status::text = 'open'::text);