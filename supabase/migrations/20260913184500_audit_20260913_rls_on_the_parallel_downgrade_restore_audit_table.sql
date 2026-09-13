-- audit_20260913_rls_on_the_parallel_downgrade_restore_audit_table
--
-- The revert-path table created by 20260913183030 shipped without row level
-- security and with the PUBLIC default SELECT grant (anon could read it), which
-- reds the smoke gate "public base tables: RLS on + no anon write" (GHA run
-- 34775121044, rls_off_base_table:audit_20260913_parallel_downgrade_restore)
-- and would fire the sentinel's Public Security Invariants arm on its next
-- sweep. Nobody reads it but a human running the revert; postgres owns it.
-- Idempotent: safe to re-run, safe alongside any concurrent fix of the same.
ALTER TABLE public.audit_20260913_parallel_downgrade_restore ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260913_parallel_downgrade_restore FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260913_parallel_downgrade_restore TO postgres, service_role;
