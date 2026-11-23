-- audit_20261122_new_public_tables_get_rls_on_create — 2026-11-22 ~5:25 PM PT (Claude Code cloud; Trevor approved the
-- "database-wide guard" in this thread: "Yes proceed with all of those", then "Go").
--
-- WHY. A table CREATEd in public lands with RLS OFF and the default anon/authenticated grants, so PostgREST serves it to
-- anyone the moment it exists. That has happened at least six times (08-30 ×2, 10-03, 10-19, 10-31, 11-06, 11-22 — the
-- last one owner's pack history, ~17 min). Each fix was a convention; the migration guard
-- (__tests__/migration-new-public-table-enables-rls.test.ts) cannot see an ad-hoc execute_sql table, and the hourly
-- healer (selfheal_audit_table_rls, audit_/scratch_ only, 20261122234542) leaves up to 59 min open.
-- check_public_security_invariants() already treats an RLS-off public base table as a HARD failure, so this invents no
-- policy: it makes that invariant hold at CREATE time instead of being detected after.
--
-- WHAT. An event trigger on ddl_command_end for CREATE TABLE / CREATE TABLE AS / SELECT INTO: every new table or
-- partitioned table in schema public gets ENABLE ROW LEVEL SECURITY. Grants are NOT touched (a product table with
-- policies works exactly as before; one with no policy reads empty to anon instead of open). The function runs as
-- the role that issued the DDL (not SECURITY DEFINER), and any failure is a WARNING, never an error, so it cannot
-- block anyone's DDL. A table that truly must run without RLS can still DISABLE it afterwards (and must still satisfy
-- check_public_security_invariants). Owner and service_role bypass RLS, so writers are unaffected.
-- Proven before applying (rolled back): a probe table created after the trigger came out relrowsecurity = true.
--
-- REVERT: DROP EVENT TRIGGER IF EXISTS rpc_public_table_rls_on_create; DROP FUNCTION IF EXISTS public.rpc_public_table_rls_on_create();

CREATE OR REPLACE FUNCTION public.rpc_public_table_rls_on_create()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  o record;
BEGIN
  FOR o IN
    SELECT c.objid, c.object_identity
      FROM pg_event_trigger_ddl_commands() c
      JOIN pg_class r ON r.oid = c.objid
     WHERE c.object_type IN ('table', 'partitioned table')
       AND c.schema_name = 'public'
       AND r.relkind IN ('r', 'p')
       AND NOT r.relrowsecurity
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', o.object_identity);
    EXCEPTION WHEN insufficient_privilege OR undefined_table OR object_not_in_prerequisite_state THEN
      RAISE WARNING 'rpc_public_table_rls_on_create: could not enable RLS on % (%); check_public_security_invariants will report it',
        o.object_identity, SQLERRM;
    END;
  END LOOP;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_public_table_rls_on_create() FROM PUBLIC, anon, authenticated;

CREATE EVENT TRIGGER rpc_public_table_rls_on_create
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rpc_public_table_rls_on_create();
