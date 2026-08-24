-- audit_20260824: add an `mv_anon_readable` arm to check_public_security_invariants().
--
-- WHY. On 2026-08-23 the rebuilt `mv_panini_squeeze` was created with `anon`
-- SELECT and the leak was caught BY HAND in verification, not by the standing
-- monitor. This migration explains why the monitor was green: it was never
-- looking. `check_public_security_invariants()` has five arms and every one of
-- them is scoped by construction to `relkind IN ('r','p')` (base tables) or
-- `relkind = 'v'` (views) or to pg_proc. NOTHING in it covers a MATERIALIZED
-- VIEW's read exposure. That is a MISSING INVARIANT, not a broken check -- the
-- existing arms are honest about what they measure.
--
-- AND `information_schema.role_table_grants` CANNOT BE USED TO FIND IT.
-- That view returns ZERO rows for a materialized view. Measured 2026-08-24
-- against the live DB, with the positive control a null result demands:
--
--     total MVs in `public`                                        34
--     rows in information_schema.role_table_grants for ANY of them   0
--     mv_panini_squeeze relacl {postgres=arwdDxtm/..,service_role=arwdDxtm/..}
--
-- The MV demonstrably HOLDS grants while information_schema reports none, so
-- the zero is the instrument's blindness and not an absence of privilege. Any
-- guard reading MV grants through information_schema passes VACUOUSLY over all
-- 34. This arm therefore reads `has_table_privilege` against pg_class, which is
-- the only source that can see them.
--
-- THE MECHANISM IS THE DEFAULT, so this WILL recur without a guard. This DB's
-- `ALTER DEFAULT PRIVILEGES` for `public` (measured 2026-08-24):
--     postgres        table/view/MV  ->  anon=rxm   authenticated=rxtm
--     supabase_admin  table/view/MV  ->  anon=arwdDxtm  (full write)
-- `r` is SELECT. Every materialized view created by `postgres` in `public` is
-- born anon-readable, and PostgREST exposes an MV the anon role can SELECT at
-- /rest/v1/<name> -- the anon key ships in the browser bundle. The 34 MVs that
-- read clean today are clean because someone revoked each one BY HAND.
--
-- BAN AT ZERO, not an allowlist -- this repo's stated preference, and it is
-- satisfiable at today's population: 0 of 34 MVs are anon- or authenticated-
-- readable as of 2026-08-24 23:30Z. So this arm adds NO rows on apply and the
-- function's contract (clean == 0 rows) is unchanged. If a materialized view is
-- ever meant to be public, make the SUPPRESSION the curated list at that point;
-- do not weaken the predicate.
--
-- Callers verified before editing (pg_proc, pg_views, cron.job, pg_trigger,
-- repo grep): DB-side `analytics_smoke_run` and `rpc_ops_snapshot`; repo-side
-- `app/api/cron/data-integrity/route.ts` and `app/api/smoke-test/route.ts`,
-- plus three __tests__ files. ALL OF THEM CONSUME IT BY COUNT (`length === 0`);
-- none switches on the `kind` string, so a new arm name cannot break a consumer.
--
-- Revert: re-apply the previous body (this file minus the `mv_anon_readable`
-- UNION ALL branch). No data is touched.

CREATE OR REPLACE FUNCTION public.check_public_security_invariants()
RETURNS TABLE(kind text, object_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
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
  -- (b) SECURITY DEFINER public views not in the accepted baseline -- catches a
  --     hardened (invoker) view silently reverting to definer (RLS-bypass read).
  --     Accepts ANY boolean-true security_invoker spelling (on/true/1/yes), not
  --     just the literal 'security_invoker=on' (hardened 2026-07-24 -- a view
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
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  UNION ALL
  -- (d) MATERIALIZED VIEWS in `public` readable by anon/authenticated.
  --     PostgREST serves an MV the role can SELECT at /rest/v1/<name>, and the
  --     anon key is public. Read via has_table_privilege on pg_class: an MV is
  --     INVISIBLE to information_schema.role_table_grants (0 rows for all 34),
  --     so the infoschema arms above are structurally blind here.
  SELECT 'mv_anon_readable'::text, c.relname::text
  FROM pg_class c JOIN pg_namespace n3 ON n3.oid = c.relnamespace
  WHERE n3.nspname = 'public' AND c.relkind = 'm'
    AND (has_table_privilege('anon', c.oid, 'SELECT')
         OR has_table_privilege('authenticated', c.oid, 'SELECT'));
$fn$;

-- anon-exec: revoked -- ops/security guard, service_role only (check_public_security_invariants).
-- CREATE OR REPLACE FUNCTION does NOT reset a function ACL, so the revoke below
-- is a no-op that PINS the already-correct state (measured immediately before
-- this migration: anon=false, authenticated=false, service_role=true). It names
-- all three roles because ALTER DEFAULT PRIVILEGES on this DB grants explicit
-- anon/authenticated rows that survive a PUBLIC-only revoke.
REVOKE EXECUTE ON FUNCTION public.check_public_security_invariants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_public_security_invariants() TO service_role;
