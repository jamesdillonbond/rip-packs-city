-- 90d catch-up enumeration for fmv-recalc (Trevor 2026-08-07 accuracy follow-up).
-- Editions that TRADE but not in the recent 30d window are never enumerated by
-- fmv_recalc_edition_page (a 30d GROUP BY), so they fall to ASK_ONLY / NO_DATA /
-- stale instead of a real 90d sales-based MEDIUM. This returns exactly that set
-- for one collection: >= MIN_SALES_30D_MEDIUM (5) sales in 90d AND zero in 30d.
-- The fmv-recalc route seeds these into its pricing loop at offset 0 only (once
-- per full sweep), where the existing 90d-widening + gateHighToRecentVolume path
-- prices them and caps confidence at MEDIUM (they have 0 recent-30d sales).
--
-- SECURITY DEFINER + function-local statement_timeout so the ~17s (warm) / up to
-- ~50s (cold) 90d scan cannot be cancelled by the caller's role timeout — the
-- same pattern as fmv_recalc_edition_page. STABLE, service_role-only EXECUTE.
-- Ordered by MAX(sold_at) DESC so if p_limit bites, the most-recently-traded
-- (freshest, most valuable) candidates win.
CREATE OR REPLACE FUNCTION public.fmv_recalc_90d_catchup_editions(
  p_collection_id uuid,
  p_limit integer DEFAULT 1000
)
RETURNS TABLE(edition_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET statement_timeout TO '90s'
SET search_path TO 'public'
AS $function$
  SELECT s.edition_id
  FROM sales s
  WHERE s.collection_id = p_collection_id
    AND s.edition_id IS NOT NULL
    AND s.sold_at >= now() - interval '90 days'
    AND s.price_usd > 0
  GROUP BY s.edition_id
  HAVING count(*) >= 5
     AND count(*) FILTER (WHERE s.sold_at >= now() - interval '30 days') = 0
  ORDER BY MAX(s.sold_at) DESC NULLS LAST
  LIMIT p_limit
$function$;

REVOKE ALL ON FUNCTION public.fmv_recalc_90d_catchup_editions(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fmv_recalc_90d_catchup_editions(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.fmv_recalc_90d_catchup_editions(uuid, integer) IS
  'fmv-recalc offset-0 catch-up: editions with >=5 sales in 90d and 0 in 30d, so the recalc can price them off the 90d window (gated to MEDIUM) instead of leaving them ASK_ONLY/NO_DATA. SECDEF, service_role-only, 90s local timeout.';
