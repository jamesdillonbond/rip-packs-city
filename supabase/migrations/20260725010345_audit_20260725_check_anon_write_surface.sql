-- check_anon_write_surface(): flags base tables anon could ACTUALLY write —
-- a write grant PLUS a permissive write policy (roles include anon/public) whose
-- USING and WITH CHECK clauses contain no auth-identity gate (auth.*, request.jwt,
-- current_setting) and are not hard-false — i.e. an unauthenticated caller can
-- satisfy them. This closes the gap check_public_security_invariants() leaves:
-- that check only catches RLS-OFF tables, so a table with RLS ON + an anon-write
-- grant + a permissive no-auth policy is an anon-write hole it never sees.
--
-- The deliberate bounded anon-insert tables (each has a length/format CHECK-style
-- WITH CHECK and is documented under CLAUDE.md "Deferred hardening") are
-- allowlisted; anything else surfacing is a real regression. Verified [] on
-- 2026-07-25. Returns () so the smoke test can assert emptiness.
-- SECURITY DEFINER + service_role-only. Revert: DROP FUNCTION public.check_anon_write_surface();
CREATE OR REPLACE FUNCTION public.check_anon_write_surface()
RETURNS TABLE(object_name text, policyname text, cmd text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH anon_write_grants AS (
    SELECT DISTINCT g.table_name
    FROM information_schema.role_table_grants g
    JOIN pg_tables t ON t.schemaname = 'public' AND t.tablename = g.table_name
    WHERE g.grantee = 'anon' AND g.table_schema = 'public'
      AND g.privilege_type IN ('INSERT','UPDATE','DELETE')
  ),
  allowlist(tablename) AS (VALUES
    ('email_subscribers'), ('funnel_events'), ('outbound_clicks'), ('support_conversations')
  )
  SELECT p.tablename::text, p.policyname::text, p.cmd::text
  FROM pg_policies p
  JOIN anon_write_grants a ON a.table_name = p.tablename
  WHERE p.schemaname = 'public'
    AND p.permissive = 'PERMISSIVE'
    AND ('anon' = ANY(p.roles) OR 'public' = ANY(p.roles))
    AND p.cmd IN ('INSERT','UPDATE','DELETE','ALL')
    AND COALESCE(p.with_check, p.qual, 'true') <> 'false'
    -- no auth-identity gate in either clause ⇒ an anonymous caller can satisfy it
    AND COALESCE(p.qual, '')       !~ '(auth\.|request\.jwt|current_setting)'
    AND COALESCE(p.with_check, '') !~ '(auth\.|request\.jwt|current_setting)'
    AND p.tablename NOT IN (SELECT tablename FROM allowlist)
  ORDER BY p.tablename, p.cmd;
$function$;

REVOKE ALL ON FUNCTION public.check_anon_write_surface() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_anon_write_surface() FROM anon;
REVOKE ALL ON FUNCTION public.check_anon_write_surface() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_anon_write_surface() TO service_role;
