-- Replace the SETOF version with a scalar text[] return so PostgREST treats
-- it as a single value (bypasses db-max-rows=1000 row cap on RPC results).
-- The earlier SETOF form was silently truncating the candidate set to 1000
-- which made the hybrid-custody-backfill edge function miss ~600 traders.
DROP FUNCTION IF EXISTS public.get_hybrid_custody_candidates(int);

CREATE OR REPLACE FUNCTION public.get_hybrid_custody_candidates(p_days int DEFAULT 90)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT array_agg(DISTINCT a) FROM (
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
