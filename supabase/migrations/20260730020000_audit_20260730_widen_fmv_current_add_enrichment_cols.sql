-- audit_20260730_widen_fmv_current_add_enrichment_cols
--
-- Applied to prod via MCP apply_migration on 2026-07-30 (this file mirrors it for
-- repo traceability). Append-only widening of the fmv_current view so the FMV read
-- paths that need enrichment columns (sales_count_30d, days_since_sale,
-- asp_without_outliers, liquidity_rating) can read the DISTINCT-ON-latest view
-- instead of a raw fmv_snapshots DESC + JS dedup — which silently drops cold
-- editions past the PostgREST 1000-row cap (~35 daily-history rows/edition).
--
-- The existing 11 columns are unchanged in name/order/type (CREATE OR REPLACE VIEW
-- requires the prefix to match and preserves grants), so every current consumer is
-- unaffected. CRITICAL: CREATE OR REPLACE VIEW wipes reloptions, so security_invoker
-- is re-asserted (else the view would run as its definer and let anon bypass
-- fmv_snapshots RLS). Verified post-apply: 26,760 rows = distinct editions,
-- security_invoker=true, has_table_privilege('anon', ...) = false.
--
-- Revert: CREATE OR REPLACE VIEW public.fmv_current back to the 11-column SELECT
-- (edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd AS wap_usd,
-- confidence, top_shot_ask, flowty_ask, cross_market_ask, computed_at, algo_version)
-- + ALTER VIEW ... SET (security_invoker = true).
CREATE OR REPLACE VIEW public.fmv_current AS
 SELECT DISTINCT ON (edition_id) edition_id,
    collection_id,
    fmv_usd,
    floor_price_usd,
    asp_usd AS wap_usd,
    confidence,
    top_shot_ask,
    flowty_ask,
    cross_market_ask,
    computed_at,
    algo_version,
    asp_without_outliers,
    sales_count_30d,
    days_since_sale,
    liquidity_rating
   FROM fmv_snapshots
  ORDER BY edition_id, computed_at DESC;
ALTER VIEW public.fmv_current SET (security_invoker = true);
