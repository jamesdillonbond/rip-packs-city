-- Deal-board read for the topshot-deal-floor-serials cron.
-- The route read `supabaseAdmin.from("topshot_deals_vs_fmv").select("external_id")`
-- inline, which gets the service_role 30s statement_timeout default and dies during
-- the 21:00-01:00 UTC peak-contention window ("deal board read: canceling statement
-- due to statement timeout"). A SECDEF RPC carries its own proconfig statement_timeout,
-- which (unlike an inline PostgREST query) DOES apply on the RPC path, so 90s survives
-- the spike. Returns text[] (scalar array, NOT subject to PostgREST's 1000-row cap) so
-- the caller sees the full deal set regardless of size.
CREATE OR REPLACE FUNCTION public.get_topshot_deal_external_ids()
RETURNS text[]
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '90s'
AS $$
  SELECT array_agg(DISTINCT external_id)
  FROM public.topshot_deals_vs_fmv
  WHERE external_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.get_topshot_deal_external_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_deal_external_ids() TO postgres, service_role;

COMMENT ON FUNCTION public.get_topshot_deal_external_ids() IS
  'Returns distinct external_ids currently on the TS edition deal board (topshot_deals_vs_fmv). SECDEF + 90s statement_timeout so the topshot-deal-floor-serials cron read survives the evening peak-contention window that was killing the inline 30s-capped query. service_role only.';
