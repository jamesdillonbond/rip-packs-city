-- audit_20260727_security_invariant_no_anon_exec_trigger_fn
-- Add a 4th invariant arm to check_public_security_invariants(): no public
-- SECURITY DEFINER `RETURNS trigger` function may be anon/authenticated-EXECUTE-able.
-- This durably guards the audit_20260727_revoke_anon_exec_trigger_functions fix:
-- unlike check_secdef_anon_exec_drift() (which accepts allowlisted data-returning
-- fns), this is NON-allowlistable -- a trigger function has no legitimate anon
-- caller, so a future "baseline" sweep can never silently re-accept one. The arm
-- returns [] in the current state (both prior offenders revoked), so the smoke gate
-- (rpc:check_public_security_invariants, scripts/smoke-gate.py) stays green. Body
-- below reproduces the live function verbatim (a prod-only object with no committed
-- migration until now) and appends only the new arm.
-- Applied live via Supabase MCP on 2026-07-27. CREATE OR REPLACE with unchanged
-- signature preserves existing EXECUTE grants (verified service_role EXECUTE intact).
-- Revert: restore the 3-arm body by dropping the final
--   `UNION ALL ... 'secdef_trigger_anon_exec' ...` SELECT (full prior body is in
--   git history and in pg_get_functiondef() prior to this migration).
CREATE OR REPLACE FUNCTION public.check_public_security_invariants()
 RETURNS TABLE(kind text, object_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT 'rls_off_base_table'::text, t.tablename::text
  FROM pg_tables t
  WHERE t.schemaname = 'public' AND t.rowsecurity = false
  UNION ALL
  SELECT 'anon_write_base_table'::text, g.table_name::text
  FROM information_schema.role_table_grants g
  JOIN pg_class c ON c.relname = g.table_name AND c.relnamespace = 'public'::regnamespace
  WHERE g.table_schema = 'public'
    AND g.grantee IN ('anon', 'authenticated')
    AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND c.relrowsecurity = false
    AND c.relkind IN ('r', 'p')
  UNION ALL
  -- (a) auto-updatable public views writable by anon/authenticated: a write
  --     through them bypasses RLS on the base table.
  SELECT 'view_updatable_anon_write'::text, v.table_name::text
  FROM information_schema.views v
  WHERE v.table_schema = 'public'
    AND v.is_insertable_into = 'YES'
    AND EXISTS (
      SELECT 1 FROM information_schema.role_table_grants g
      WHERE g.table_schema = 'public' AND g.table_name = v.table_name
        AND g.grantee IN ('anon', 'authenticated')
        AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
  UNION ALL
  -- (b) SECURITY DEFINER public views not in the accepted baseline — catches a
  --     hardened (invoker) view silently reverting to definer (RLS-bypass read).
  --     Accepts ANY boolean-true security_invoker spelling (on/true/1/yes), not
  --     just the literal 'security_invoker=on' (hardened 2026-07-24 — a view
  --     created WITH (security_invoker = true) is invoker and must not flag).
  SELECT 'view_unexpected_definer'::text, c.relname::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v'
    AND NOT EXISTS (
      SELECT 1 FROM pg_options_to_table(COALESCE(c.reloptions, '{}'::text[])) o
      WHERE o.option_name = 'security_invoker'
        AND lower(o.option_value) IN ('on', 'true', '1', 'yes'))
    AND NOT EXISTS (
      SELECT 1 FROM public.security_definer_view_allowlist a
      WHERE a.view_name = c.relname)
  UNION ALL
  -- (c) SECURITY DEFINER trigger functions must NEVER be anon/authenticated-
  --     EXECUTE-able. A `RETURNS trigger` function cannot be legitimately invoked
  --     via PostgREST /rest/v1/rpc/ (references NEW/TG_* and errors without a
  --     trigger context) and its trigger fires as definer regardless of the
  --     caller's grant, so an anon/auth grant is pure attack surface. Non-
  --     allowlistable: no trigger fn ever legitimately belongs on the anon surface.
  SELECT 'secdef_trigger_anon_exec'::text, (p.oid::regprocedure)::text
  FROM pg_proc p
  JOIN pg_namespace n2 ON n2.oid = p.pronamespace
  WHERE n2.nspname = 'public'
    AND p.prosecdef
    AND pg_get_function_result(p.oid) = 'trigger'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
$function$;
