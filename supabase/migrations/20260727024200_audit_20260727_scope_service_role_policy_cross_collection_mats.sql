-- audit_20260727_scope_service_role_policy_cross_collection_mats
-- Performance advisor `multiple_permissive_policies`: on the two
-- cross_collection_*_mat analytics MVs, `service_role_all` was TO public (all
-- roles) but its qual only ever grants service_role, so every anon/authenticated
-- SELECT needlessly evaluated it alongside `public_read`. Narrow it TO service_role.
-- Behavior-preserving: anon/auth SELECT is still granted by public_read; their
-- writes were (and remain) default-denied; service_role keeps full access.
-- Applied live via Supabase MCP on 2026-07-27.
-- Revert: ALTER POLICY service_role_all ON <table> TO public; for each.
ALTER POLICY service_role_all ON public.cross_collection_cohort_mat TO service_role;
ALTER POLICY service_role_all ON public.cross_collection_ts_set_overlap_mat TO service_role;
