-- audit_20260830_get_market_summary_counts_edition_fmv_current_not_the_distinct_on_view
--
-- WHY: get_market_summary() (behind the cookie-gated /api/market/summary) took 9,485 ms and 6.48 M shared
-- buffer hits on an idle instance (16:5xZ, EXPLAIN through the function), for one reason: its
-- `editions_with_fmv` sub-select is `COUNT(*) FROM fmv_current WHERE collection_id = c.id`, and fmv_current
-- is the DISTINCT ON (edition_id) view over fmv_snapshots -- a full 1.31 M-row pass per call, five times
-- (once per active collection). Same class as the five functions re-shaped earlier today (ledger 2026-08-30).
--
-- WHAT: count edition_fmv_current instead -- the hourly-refreshed table of exactly the same rows (verified
-- 16:5xZ: per-collection counts identical for all five collections, 27,150 rows). It lags the view by at most
-- the refresh_edition_fmv_current watermark (<= 1 h), which for an "editions with any FMV" count is nothing.
-- No signature change; ACL (postgres, service_role only) is preserved by CREATE OR REPLACE and re-asserted.
-- anon-exec: get_market_summary (no anon/authenticated EXECUTE before or after; ACL re-asserted below)
--
-- REVERT: re-apply the prior body with `FROM fmv_current` (in git history at this migration's parent).

CREATE OR REPLACE FUNCTION public.get_market_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_object_agg(slug, stats)
  FROM (
    SELECT 
      c.slug,
      jsonb_build_object(
        'sales_24h', (SELECT COUNT(*) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '24 hours' AND price_usd > 0),
        'volume_24h_usd', (SELECT ROUND(COALESCE(SUM(price_usd), 0)::numeric, 0) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '24 hours'),
        'sales_7d', (SELECT COUNT(*) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '7 days' AND price_usd > 0),
        'volume_7d_usd', (SELECT ROUND(COALESCE(SUM(price_usd), 0)::numeric, 0) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '7 days'),
        'distinct_buyers_7d', (SELECT COUNT(DISTINCT buyer_address) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '7 days' AND buyer_address IS NOT NULL),
        'avg_price_7d', (SELECT ROUND(COALESCE(AVG(price_usd), 0)::numeric, 2) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '7 days' AND price_usd > 0),
        'editions_total', (SELECT COUNT(*) FROM editions WHERE collection_id = c.id),
        -- edition_fmv_current = the same latest-row-per-edition set as the fmv_current view, materialised hourly.
        'editions_with_fmv', (SELECT COUNT(*) FROM edition_fmv_current WHERE collection_id = c.id)
      ) AS stats
    FROM collections c
    WHERE c.is_active = true
  ) sub;
$function$;

REVOKE ALL ON FUNCTION public.get_market_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_market_summary() TO postgres, service_role;
