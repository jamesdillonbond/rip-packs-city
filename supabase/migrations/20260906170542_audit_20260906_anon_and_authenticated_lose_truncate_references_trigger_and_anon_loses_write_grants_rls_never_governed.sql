-- audit_20260906_anon_and_authenticated_lose_truncate_references_trigger_and_anon_loses_write_grants_rls_never_governed
--
-- CISO pass, 2026-09-06 (read-only review, then this). Measured live:
--   · anon held TRUNCATE on 146 public tables (sales, editions, fmv_snapshots,
--     moments, collections, every partition); authenticated on 152.
--   · anon + authenticated held REFERENCES / TRIGGER on 1,058 table-grants.
--   · anon held INSERT/UPDATE/DELETE on 45 tables.
-- Root cause is recorded in docs/reference/database.md (the pre-tightening
-- `ALTER DEFAULT PRIVILEGES` era): the CURRENT default for postgres-created
-- tables is already `anon=rxm / authenticated=rxtm`, so these are the grants
-- that older tables kept. RLS makes INSERT/UPDATE/DELETE inert today (every
-- permissive write policy is auth.uid()-scoped, service_role-only, or a deny),
-- ⛔ but TRUNCATE IS NOT GOVERNED BY RLS AT ALL. Today no anon-executable
-- function contains TRUNCATE, so the grant is dormant — dormant is not the
-- same as absent, and one INVOKER function away from `TRUNCATE sales`.
--
-- What this does (postgres is the grantor of every grant it revokes here — the
-- `net`/`cron` schema grants are supabase_admin's and CANNOT be revoked from
-- this role; that finding is recorded in known-issues instead):
--   1. REVOKE TRUNCATE, REFERENCES, TRIGGER on every public table from anon
--      and authenticated.
--   2. REVOKE INSERT, UPDATE, DELETE from anon on every public table EXCEPT the
--      four anonymous-telemetry/signup tables whose anon INSERT policies are
--      intentional (email_subscribers, funnel_events, outbound_clicks,
--      support_conversations) and `portfolios` (own_portfolio, jwt-scoped).
--      authenticated keeps its write grants — its policies are the product.
-- Verification is inline and RAISEs (rolls back) if a positive control fails:
-- anon must still SELECT editions and still INSERT outbound_clicks.
--
-- Revert: re-grant is the inverse (`GRANT TRUNCATE ... TO anon` etc.); there is
-- no product path that needs it, so the revert is a security regression by
-- definition — record why before doing it.

DO $revoke$
DECLARE
  t record;
  v_n int;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     -- views and matviews carry these grants too (ALL was granted); TRUNCATE on
     -- a view is meaningless but the acl bit is real and role_table_grants lists it
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM anon, authenticated', t.relname);
    IF t.relname NOT IN ('email_subscribers', 'funnel_events', 'outbound_clicks', 'support_conversations', 'portfolios') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM anon', t.relname);
    END IF;
  END LOOP;

  -- Post-conditions (each one a measured number from before the change).
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE grantee IN ('anon', 'authenticated') AND table_schema = 'public'
     AND privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER');
  IF v_n <> 0 THEN RAISE EXCEPTION 'TRUNCATE/REFERENCES/TRIGGER grants remain: % (expected 0)', v_n; END IF;

  SELECT count(DISTINCT table_name) INTO v_n FROM information_schema.role_table_grants
   WHERE grantee = 'anon' AND table_schema = 'public'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_n > 5 THEN RAISE EXCEPTION 'anon still writes % tables (expected <= 5)', v_n; END IF;

  -- Positive controls: the product must still work for an anonymous reader.
  IF NOT has_table_privilege('anon', 'public.editions', 'SELECT') THEN RAISE EXCEPTION 'control failed: anon lost SELECT on editions'; END IF;
  IF NOT has_table_privilege('anon', 'public.outbound_clicks', 'INSERT') THEN RAISE EXCEPTION 'control failed: anon lost INSERT on outbound_clicks'; END IF;
  IF NOT has_table_privilege('anon', 'public.email_subscribers', 'INSERT') THEN RAISE EXCEPTION 'control failed: anon lost INSERT on email_subscribers'; END IF;
  -- (first draft named saved_wallets here and the control FAILED before anything
  -- was revoked: authenticated never held INSERT on it — those writes go through
  -- service_role API routes. A control must be true BEFORE the change.)
  IF NOT has_table_privilege('authenticated', 'public.trophy_moments', 'INSERT') THEN RAISE EXCEPTION 'control failed: authenticated lost INSERT on trophy_moments'; END IF;
  IF has_table_privilege('anon', 'public.sales', 'TRUNCATE') THEN RAISE EXCEPTION 'anon can still TRUNCATE sales'; END IF;
  IF has_table_privilege('anon', 'public.editions', 'DELETE') THEN RAISE EXCEPTION 'anon can still DELETE editions'; END IF;

  RAISE NOTICE 'anon/authenticated table grants tightened; anon write tables now: %',
    (SELECT string_agg(DISTINCT table_name, ', ') FROM information_schema.role_table_grants
      WHERE grantee = 'anon' AND table_schema = 'public' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE'));
END
$revoke$;
