-- audit_20260713_log_pipeline_run_3arg_overload
-- The 11-arg log_pipeline_run requires p_started_at (no default), so a caller logging via
-- supabase.rpc('log_pipeline_run', {p_pipeline, p_ok, p_extra}) -- e.g.
-- app/api/cron/ingest-topshot-challenges -- silently failed to resolve and wrote nothing:
-- the challenge ingest RAN and refreshed data but was invisible to pipeline_runs / the monitor.
-- This adds an unambiguous 3-arg overload (the 11-arg cannot match a 3-key call since
-- p_started_at has no default) delegating to the canonical logger. service_role only.
-- Applied live via Supabase MCP 2026-07-13; repo/DB parity. Revert: DROP FUNCTION
-- public.log_pipeline_run(text, boolean, jsonb).
CREATE OR REPLACE FUNCTION public.log_pipeline_run(p_pipeline text, p_ok boolean, p_extra jsonb)
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.log_pipeline_run(
    p_pipeline     := p_pipeline,
    p_started_at   := now(),
    p_rows_found   := COALESCE(NULLIF(p_extra->>'fetched','')::int, 0),
    p_rows_written := COALESCE(NULLIF(p_extra->>'upserted','')::int, 0),
    p_rows_skipped := COALESCE(NULLIF(p_extra->>'skipped','')::int, 0),
    p_ok           := p_ok,
    p_error        := p_extra->>'error',
    p_extra        := p_extra
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.log_pipeline_run(text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_pipeline_run(text, boolean, jsonb) TO postgres, service_role;
