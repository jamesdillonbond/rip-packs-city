-- audit_20260729_fix_cursor_stall_threshold_search_path
--
-- Applied to prod via MCP apply_migration on 2026-07-29 (this file mirrors it for
-- repo traceability). Clears the lone `function_search_path_mutable` advisor WARN:
-- cursor_stall_threshold() had a role-mutable search_path. It is a pure constant
-- function (no object refs), so pinning search_path='' is behavior-identical and
-- keeps IMMUTABLE PARALLEL SAFE — it just removes the last outstanding search_path
-- lint so a real future one stands out.
--
-- Revert:
--   CREATE OR REPLACE FUNCTION public.cursor_stall_threshold()
--     RETURNS interval LANGUAGE sql IMMUTABLE PARALLEL SAFE
--     AS $$ SELECT interval '6 hours' $$;   -- (drops the SET search_path)

CREATE OR REPLACE FUNCTION public.cursor_stall_threshold()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path = ''
AS $function$ SELECT interval '6 hours' $function$;
