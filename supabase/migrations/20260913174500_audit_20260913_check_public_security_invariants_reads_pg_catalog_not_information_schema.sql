-- audit_20260913: check_public_security_invariants() reads pg_catalog, not
-- information_schema — 27,634 → 3,758 buffers per call, same six arms.
--
-- WHY. The new "Ops Probe Cost" sentinel arm (20260913163000) ranked every ops
-- RPC by buffers per call. After the two sentinel probes were fixed, the heaviest
-- remaining one was this function: pg_stat_statements since 2026-08-12 read
--   calls 2,362 · mean 1,028 ms · max 16,642 ms · 26,193 blocks/call
-- i.e. ~61.9M blocks ≈ 494 GB of buffer-cache reads over the month (almost all
-- shared HITS — 27,634 hit / 38 read on a fresh EXPLAIN — so cache and CPU churn
-- on a 2-core box, not disk), invoked ~78×/day by /api/cron/data-integrity for a
-- check whose answer changes only when a migration lands.
--
-- WHERE THE COST WAS. Two of the six arms went through
-- information_schema.role_table_grants (once directly, once inside an EXISTS
-- per view) and information_schema.views. Those views expand the ACL of every
-- relation and column in the database on each read. The other four arms already
-- read pg_catalog directly and are byte-identical here.
--
-- THE REWRITE, arm by arm:
--   anon_write_base_table   — pg_class rows in public, relkind r/p, relrowsecurity
--                             false, filtered by has_table_privilege(role, oid,
--                             INSERT|UPDATE|DELETE|TRUNCATE) for anon and
--                             authenticated.
--   view_updatable_anon_write — pg_class views in public where
--                             (pg_relation_is_updatable(oid, false) & 8) = 8 —
--                             the exact expression information_schema.views uses
--                             for is_insertable_into — with the same
--                             has_table_privilege filter.
--   the other four           — unchanged.
--
-- ⚠ ONE DELIBERATE WIDENING, stated so it is not read as drift: role_table_grants
-- lists a grant under the grantee it was made TO, so a write privilege reaching
-- anon through PUBLIC (or role membership) was INVISIBLE to the old arms;
-- has_table_privilege answers "can this role do it", which includes those paths.
-- A table anon can write via PUBLIC is exactly as exposed as one granted
-- directly, so the new reading is the correct one. Today both readings are
-- empty, so nothing changes in the report.
--
-- MEASURED (live, 2026-09-13 10:1x PT, under an active saturation spell):
--   old: 27,634 shared hit + 38 read, 363 ms, 0 rows
--   new:  3,530 shared hit + 228 read, 1,063 ms (490 ms of it PLANNING — the
--         eight has_table_privilege calls per row plan slowly; under load), 0 rows
-- POSITIVE CONTROL (a null result needs one): a probe table with RLS off and an
-- anon INSERT grant plus an auto-updatable view over it with an authenticated
-- UPDATE grant, created, compared, dropped within the same minute:
--   rls_off_base_table / anon_write_base_table / view_updatable_anon_write —
--   flagged by BOTH old and new, object for object. (view_unexpected_definer
--   also fired for the probe view, in the unchanged arm.)
--
-- Return shape, name, security model and grants are unchanged (CREATE OR REPLACE
-- keeps the ACL; verified with has_function_privilege after apply).
-- REVERT: re-apply the previous body — recorded verbatim in
--   docs/overnight/ledger.md (2026-09-13, "the sentinel watches its own weight")
--   and in the migration that last defined it (grep check_public_security_invariants).
--
-- anon-exec: unchanged — SNAPSHOT of an existing SECDEF function whose ACL already excludes anon/authenticated (verified after apply); a REVOKE here would be a no-op pretending to be a decision (check_public_security_invariants)
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
  -- Base tables in public with RLS off that anon/authenticated can WRITE.
  -- has_table_privilege, not information_schema.role_table_grants: the view
  -- expands every ACL in the database per read (the 27k-buffer cost), and it
  -- cannot see a privilege reaching the role through PUBLIC.
  SELECT 'anon_write_base_table'::text, c.relname::text
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relkind IN ('r', 'p')
    AND c.relrowsecurity = false
    AND (   has_table_privilege('anon', c.oid, 'INSERT')
         OR has_table_privilege('anon', c.oid, 'UPDATE')
         OR has_table_privilege('anon', c.oid, 'DELETE')
         OR has_table_privilege('anon', c.oid, 'TRUNCATE')
         OR has_table_privilege('authenticated', c.oid, 'INSERT')
         OR has_table_privilege('authenticated', c.oid, 'UPDATE')
         OR has_table_privilege('authenticated', c.oid, 'DELETE')
         OR has_table_privilege('authenticated', c.oid, 'TRUNCATE'))
  UNION ALL
  -- (a) auto-updatable public views writable by anon/authenticated: a write
  --     through them bypasses RLS on the base table. `& 8` is INSERT in the
  --     pg_relation_is_updatable bitmask — the same test information_schema.views
  --     applies for is_insertable_into.
  SELECT 'view_updatable_anon_write'::text, c.relname::text
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relkind = 'v'
    AND (pg_relation_is_updatable(c.oid, false) & 8) = 8
    AND (   has_table_privilege('anon', c.oid, 'INSERT')
         OR has_table_privilege('anon', c.oid, 'UPDATE')
         OR has_table_privilege('anon', c.oid, 'DELETE')
         OR has_table_privilege('anon', c.oid, 'TRUNCATE')
         OR has_table_privilege('authenticated', c.oid, 'INSERT')
         OR has_table_privilege('authenticated', c.oid, 'UPDATE')
         OR has_table_privilege('authenticated', c.oid, 'DELETE')
         OR has_table_privilege('authenticated', c.oid, 'TRUNCATE'))
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
$function$;

COMMENT ON FUNCTION public.check_public_security_invariants() IS
  'Six public-schema security arms (RLS-off base tables, anon/authenticated-writable base tables, updatable views writable by those roles, non-allowlisted definer views, anon-executable SECDEF trigger functions, anon-readable materialized views). Reads pg_catalog only since 2026-09-13: the information_schema.role_table_grants path cost ~27k buffers per call at ~78 calls/day. Write arms use has_table_privilege, so a privilege reaching anon through PUBLIC is caught (the old view could not see it). Clean baseline = 0 rows. Caller: /api/cron/data-integrity.';
