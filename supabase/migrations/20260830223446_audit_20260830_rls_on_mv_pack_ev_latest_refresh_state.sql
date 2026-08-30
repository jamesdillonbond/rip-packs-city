-- audit_20260830_rls_on_mv_pack_ev_latest_refresh_state
--
-- WHY: migration 20260830222057 created public.mv_pack_ev_latest_refresh_state with anon/authenticated REVOKED but
-- WITHOUT enabling row-level security — and the smoke suite's hard invariant ("public base tables: RLS on + no anon
-- write") went red on the very next run (rls_off_base_table:mv_pack_ev_latest_refresh_state). The guard is right:
-- grants and RLS are independent layers here, and every other public base table carries both.
--
-- WHAT: enable RLS, add no policies. The only writers are the SECURITY DEFINER function
-- refresh_mv_pack_ev_latest() (runs as the table owner, which RLS does not restrict without FORCE) and service_role
-- (bypasses RLS by role attribute); nothing else needs read access beyond service_role's existing GRANT.
--
-- REVERT: ALTER TABLE public.mv_pack_ev_latest_refresh_state DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.mv_pack_ev_latest_refresh_state ENABLE ROW LEVEL SECURITY;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='mv_pack_ev_latest_refresh_state' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: RLS still off';
  END IF;
END
$mig$;
