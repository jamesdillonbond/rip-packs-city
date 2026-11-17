-- 2026-09-11. 🚨 SELF-INFLICTED, FOUND BY THE ADVISOR AND FIXED IN THE SAME PASS.
--
-- `audit_20260911_wmc_rekey_fmv_repoint` was created WITHOUT row-level security and
-- landed with SELECT granted to BOTH `anon` and `authenticated` — i.e. readable
-- anonymously through PostgREST. It holds wallet addresses, moment ids and FMV
-- values: not secrets, but other people's collection data, and a public read surface
-- I introduced.
--
-- ⚠ ITS SIBLING FROM THE SAME SESSION WAS FINE (`audit_20260911_wmc_parallel_to_base_rekey`
-- came out with RLS enabled and no grants), which is exactly why this needed the
-- ADVISOR rather than my memory of what I had just done — two tables created minutes
-- apart in the same style ended up in different postures.
--
-- ⚠ THE NORM WAS ALREADY THERE TO COPY: every pre-existing `audit_*` table in this
-- schema is RLS-enabled with no anon/authenticated SELECT (checked 12 of them). RLS
-- on with NO POLICY is the intended deny-all state for an operator table — it is what
-- the advisor reports as the benign INFO `rls_enabled_no_policy`, not a gap.
--
-- ⚠ REVOKE FROM PUBLIC, anon AND authenticated IN ONE STATEMENT — either half alone
-- leaves a grant behind (the PUBLIC default and ALTER DEFAULT PRIVILEGES).
--
-- anon-exec: n/a — no function is created here; this migration is grants and RLS only.

ALTER TABLE public.audit_20260911_wmc_rekey_fmv_repoint ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.audit_20260911_wmc_rekey_fmv_repoint FROM PUBLIC, anon, authenticated;

-- Belt and braces on the sibling: it is already correct, and ENABLE is idempotent.
ALTER TABLE public.audit_20260911_wmc_parallel_to_base_rekey ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260911_wmc_parallel_to_base_rekey FROM PUBLIC, anon, authenticated;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('audit_20260911_wmc_rekey_fmv_repoint',
                         'audit_20260911_wmc_parallel_to_base_rekey')
  LOOP
    -- Verified with has_table_privilege, never by reading acl text.
    IF NOT r.relrowsecurity
       OR has_table_privilege('anon', r.oid, 'SELECT')
       OR has_table_privilege('authenticated', r.oid, 'SELECT') THEN
      RAISE EXCEPTION '% still readable or RLS off after the fix', r.relname;
    END IF;
  END LOOP;
END $$;

-- REVERT (do not — this closes a public read):
--   ALTER TABLE public.audit_20260911_wmc_rekey_fmv_repoint DISABLE ROW LEVEL SECURITY;
--   GRANT SELECT ON public.audit_20260911_wmc_rekey_fmv_repoint TO anon, authenticated;