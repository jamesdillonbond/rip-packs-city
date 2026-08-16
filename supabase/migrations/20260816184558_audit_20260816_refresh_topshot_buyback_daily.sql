-- Daily refresh for the buyback analytics MV. Runs after the institutional
-- snapshot diff lands (~07:53Z), so the MV is at most one snapshot behind.
--
-- CONCURRENTLY so readers are never blocked; it requires the unique index
-- ux_topshot_buyback_daily_grain and will raise 55000 without it.
--
-- Revert: DROP FUNCTION IF EXISTS public.refresh_topshot_buyback_daily();
CREATE OR REPLACE FUNCTION public.refresh_topshot_buyback_daily()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_buyback_daily;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_topshot_buyback_daily() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_buyback_daily() TO service_role;
