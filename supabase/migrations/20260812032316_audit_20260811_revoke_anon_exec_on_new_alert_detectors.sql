-- Follow-up to audit_20260811_edge_fn_http_error_arm_and_candy_treasury_crosscheck.
--
-- REVOKE ... FROM PUBLIC was NOT sufficient: Supabase default privileges grant
-- EXECUTE to anon/authenticated EXPLICITLY, so has_function_privilege('anon',...)
-- stayed true on all three functions. Critically, get_pipeline_alerts() had been
-- postgres+service_role ONLY before the rename; recreating the freed name picked
-- up the default grants and widened it to anon. That is a regression introduced
-- by the previous migration and is closed here.
--
-- Both revokes are required: FROM PUBLIC (the default ACL entry) AND FROM
-- anon, authenticated (the explicit Supabase default-privilege rows).

REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_candy_treasury_divergence()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_pipeline_alerts()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_pipeline_alerts_core()            FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_candy_treasury_divergence()     TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pipeline_alerts()                 TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pipeline_alerts_core()            TO service_role;
