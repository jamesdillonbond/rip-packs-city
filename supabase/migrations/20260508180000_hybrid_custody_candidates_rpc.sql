-- get_hybrid_custody_candidates(p_days int) — initial SETOF text version.
-- Returns the deduplicated address universe the hybrid-custody-backfill
-- edge function should probe.
--
-- Superseded by 20260508180100_hybrid_custody_candidates_array_return.sql
-- which switches the return type to text[] (a scalar). PostgREST applies
-- db-max-rows=1000 to row-returning RPCs, which silently truncated the
-- candidate set to 1000 in production. Scalar arrays bypass that cap.
-- Kept here for migration ordering integrity.
CREATE OR REPLACE FUNCTION public.get_hybrid_custody_candidates(p_days int DEFAULT 90)
RETURNS TABLE(addr text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT a FROM (
    SELECT wallet_address AS a FROM public.seeded_wallets WHERE is_active = true AND wallet_address IS NOT NULL
    UNION
    SELECT wallet_addr     FROM public.saved_wallets   WHERE wallet_addr     IS NOT NULL
    UNION
    SELECT buyer_address   FROM public.analytics_sales WHERE buyer_address  IS NOT NULL AND sold_at > now() - make_interval(days => p_days)
    UNION
    SELECT seller_address  FROM public.analytics_sales WHERE seller_address IS NOT NULL AND sold_at > now() - make_interval(days => p_days)
  ) u
  WHERE a IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION public.get_hybrid_custody_candidates(int) TO service_role;
