-- audit_20260907: RLS on topshot_atlas_edition_verified — check_public_security_invariants()
-- flagged the new table (rls_off_base_table) minutes after 20260907024130 created it. The table
-- is read only by SECDEF functions and service_role; no policy is needed (RLS on + no policy =
-- nothing readable by anon/authenticated even if a grant reappears).
-- REVERT: ALTER TABLE public.topshot_atlas_edition_verified DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.topshot_atlas_edition_verified ENABLE ROW LEVEL SECURITY;
