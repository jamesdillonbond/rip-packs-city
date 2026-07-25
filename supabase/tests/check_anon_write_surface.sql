-- DB invariant: public.check_anon_write_surface() — a SECURITY honesty gate wired
-- into the smoke-test battery (app/api/smoke-test/route.ts). It flags any public
-- base table an UNAUTHENTICATED caller could actually write: a table carrying an
-- anon INSERT/UPDATE/DELETE grant PLUS a permissive write policy (roles include
-- anon/public) whose USING/WITH CHECK clauses contain no auth-identity gate
-- (auth.* / request.jwt / current_setting) and are not hard-false. This closes
-- the hole check_public_security_invariants() misses (it only catches RLS-OFF
-- tables), so a regression here silently re-opens an anon-write surface that no
-- app signal would reveal until abuse — exactly why it is pinned.
--
-- The deliberate bounded anon-insert tables (email_subscribers, funnel_events,
-- outbound_clicks, support_conversations — see CLAUDE.md "Deferred hardening")
-- are allowlisted inside the function and must NOT surface.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260725010345_audit_20260725_check_anon_write_surface.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Reads live catalogs (pg_policies / information_schema.role_table_grants), so the
-- fixtures here are REAL tables with REAL anon grants + RLS policies, all created
-- and torn down inside a rolled-back transaction. Needs an `anon` role: created
-- here if absent (vanilla postgres:16 has none; Supabase does), rolled back with
-- everything else.

BEGIN;

-- Ensure the `anon` role exists (idempotent — Supabase already has it).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END $$;

-- >>> BEGIN verbatim check_anon_write_surface (keep byte-identical to the migration) >>>
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
-- <<< END verbatim check_anon_write_surface <<<

-- ── Fixtures — each row below is one table the function must classify ───────────

-- (A) THE HOLE: anon INSERT grant + permissive INSERT policy WITH CHECK (true),
--     no auth gate ⇒ must be FLAGGED.
CREATE TABLE public.sq_anon_hole (id int);
ALTER TABLE public.sq_anon_hole ENABLE ROW LEVEL SECURITY;
GRANT INSERT ON public.sq_anon_hole TO anon;
CREATE POLICY sq_anon_hole_ins ON public.sq_anon_hole FOR INSERT TO anon WITH CHECK (true);

-- (B) A SECOND hole on a different write cmd: anon UPDATE grant + permissive
--     UPDATE policy USING (true) (the qual path, not with_check) ⇒ FLAGGED.
CREATE TABLE public.sq_anon_update (id int);
ALTER TABLE public.sq_anon_update ENABLE ROW LEVEL SECURITY;
GRANT UPDATE ON public.sq_anon_update TO anon;
CREATE POLICY sq_anon_update_upd ON public.sq_anon_update FOR UPDATE TO anon USING (true);

-- (C) AUTH-GATED: anon INSERT grant but the policy references current_setting
--     (an auth-identity gate) ⇒ an anon caller can't necessarily satisfy it ⇒ NOT flagged.
CREATE TABLE public.sq_anon_gated (id int);
ALTER TABLE public.sq_anon_gated ENABLE ROW LEVEL SECURITY;
GRANT INSERT ON public.sq_anon_gated TO anon;
CREATE POLICY sq_anon_gated_ins ON public.sq_anon_gated FOR INSERT TO anon
  WITH CHECK (current_setting('request.jwt.claims', true) IS NOT NULL);

-- (D) HARD-FALSE: anon INSERT grant + policy WITH CHECK (false) ⇒ nothing can
--     satisfy it ⇒ NOT flagged.
CREATE TABLE public.sq_anon_hardfalse (id int);
ALTER TABLE public.sq_anon_hardfalse ENABLE ROW LEVEL SECURITY;
GRANT INSERT ON public.sq_anon_hardfalse TO anon;
CREATE POLICY sq_anon_hardfalse_ins ON public.sq_anon_hardfalse FOR INSERT TO anon WITH CHECK (false);

-- (E) READ-ONLY GRANT: anon has only SELECT (no write grant) even though a
--     permissive write policy exists ⇒ NOT flagged (the grant filter excludes it).
CREATE TABLE public.sq_anon_select_only (id int);
ALTER TABLE public.sq_anon_select_only ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sq_anon_select_only TO anon;
CREATE POLICY sq_anon_select_only_ins ON public.sq_anon_select_only FOR INSERT TO anon WITH CHECK (true);

-- (F) POLICY-BUT-NO-GRANT: a permissive anon write policy but NO anon write grant
--     ⇒ NOT flagged (PostgreSQL requires the grant AND the policy to write).
CREATE TABLE public.sq_no_grant (id int);
ALTER TABLE public.sq_no_grant ENABLE ROW LEVEL SECURITY;
CREATE POLICY sq_no_grant_ins ON public.sq_no_grant FOR INSERT TO anon WITH CHECK (true);

-- (G) ALLOWLISTED: the shape of (A) exactly, but on a deliberately-bounded table
--     name ⇒ excluded by the in-function allowlist ⇒ NOT flagged.
CREATE TABLE public.email_subscribers (id int);
ALTER TABLE public.email_subscribers ENABLE ROW LEVEL SECURITY;
GRANT INSERT ON public.email_subscribers TO anon;
CREATE POLICY email_subscribers_ins ON public.email_subscribers FOR INSERT TO anon WITH CHECK (true);

-- ── Assertions ─────────────────────────────────────────────────────────────────

-- Exactly the two genuine holes surface — nothing else.
SELECT _assert(
  (SELECT count(*) FROM public.check_anon_write_surface()) = 2,
  'exactly 2 anon-write holes detected (sq_anon_hole + sq_anon_update)');

-- (A) with_check (true) INSERT hole flagged, with the right cmd.
SELECT _assert(
  EXISTS (SELECT 1 FROM public.check_anon_write_surface()
          WHERE object_name = 'sq_anon_hole' AND cmd = 'INSERT'),
  'sq_anon_hole flagged as an INSERT hole');

-- (B) USING (true) UPDATE hole flagged via the qual path.
SELECT _assert(
  EXISTS (SELECT 1 FROM public.check_anon_write_surface()
          WHERE object_name = 'sq_anon_update' AND cmd = 'UPDATE'),
  'sq_anon_update flagged as an UPDATE hole (qual path)');

-- (C) auth-identity gate ⇒ excluded.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.check_anon_write_surface() WHERE object_name = 'sq_anon_gated'),
  'auth-gated policy (current_setting) is NOT flagged');

-- (D) hard-false WITH CHECK ⇒ excluded.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.check_anon_write_surface() WHERE object_name = 'sq_anon_hardfalse'),
  'hard-false policy is NOT flagged');

-- (E) no anon write grant ⇒ excluded.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.check_anon_write_surface() WHERE object_name = 'sq_anon_select_only'),
  'SELECT-only anon grant is NOT flagged');

-- (F) permissive policy without the grant ⇒ excluded.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.check_anon_write_surface() WHERE object_name = 'sq_no_grant'),
  'policy without an anon write grant is NOT flagged');

-- (G) allowlisted table ⇒ excluded despite matching the hole shape exactly.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.check_anon_write_surface() WHERE object_name = 'email_subscribers'),
  'allowlisted bounded table (email_subscribers) is NOT flagged');

SELECT '✓ check_anon_write_surface invariants pass' AS result;
ROLLBACK;
