-- audit_20261122_scratch_backfill_pk_trevor_rls_on — 2026-11-22 ~3:30 PM PT (Claude Code cloud, autonomous pass).
--
-- WHY. A scratch table (pack buy/rip/sell rows for one owner, ~3,981 rows) was left in public with RLS off and an
-- anon SELECT grant: check_public_security_invariants → rls_off_base_table:scratch_backfill_pk_trevor, and the
-- /api/smoke-test hard failure in Vercel from ~3:13 PM PT. Readable through PostgREST by anyone.
--
-- WHAT. RLS on + no PUBLIC/anon/authenticated grants. The owner (postgres) and service_role bypass RLS, so the
-- portfolio backfill that uses it is unaffected. Guarded: a no-op once the scratch table is dropped.
--
-- REVERT: ALTER TABLE public.scratch_backfill_pk_trevor DISABLE ROW LEVEL SECURITY; (never re-grant anon).
DO $g$ BEGIN
  IF to_regclass('public.scratch_backfill_pk_trevor') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.scratch_backfill_pk_trevor ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public.scratch_backfill_pk_trevor FROM PUBLIC, anon, authenticated';
  END IF;
END $g$;
