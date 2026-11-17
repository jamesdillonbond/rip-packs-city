-- audit_20260727_revoke_anon_exec_trigger_functions
-- Security advisor `anon/authenticated_security_definer_function_executable`:
-- the only two public SECDEF `RETURNS trigger` functions carrying an anon/
-- authenticated EXECUTE grant. A trigger function cannot be legitimately invoked
-- via PostgREST `/rest/v1/rpc/<fn>` (it references NEW/TG_* and errors without a
-- trigger context), and its trigger fires as the function's definer regardless of
-- the caller's grant -- so the anon/auth EXECUTE is pure surface with zero
-- legitimate caller. Both were bulk-swept into secdef_anon_exec_allowlist on the
-- 2026-07-20 "baseline" (handoff item 4), not decided per-function; per the
-- CLAUDE.md rule ("revoke rather than allowlist for fns not reached by anon"),
-- revoke and drop the stale allowlist rows. Triggers are unaffected.
-- Applied live via Supabase MCP on 2026-07-27. After: anon/auth EXECUTE false on
-- both, allowlist 63->61, check_public_security_invariants()/check_anon_write_surface() [].
-- Revert:
--   GRANT EXECUTE ON FUNCTION public.editions_block_topshot_uuid_dupe()   TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.pack_purchases_set_is_primary_drop() TO anon, authenticated;
--   INSERT INTO public.secdef_anon_exec_allowlist (identity, note, approved_at) VALUES
--     ('editions_block_topshot_uuid_dupe()',   'baseline 2026-07-20 (handoff item 4)', '2026-07-21 00:33:40.842992+00'),
--     ('pack_purchases_set_is_primary_drop()', 'baseline 2026-07-20 (handoff item 4)', '2026-07-21 00:33:40.842992+00');
REVOKE EXECUTE ON FUNCTION public.editions_block_topshot_uuid_dupe()   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pack_purchases_set_is_primary_drop() FROM PUBLIC, anon, authenticated;
DELETE FROM public.secdef_anon_exec_allowlist
 WHERE identity IN ('editions_block_topshot_uuid_dupe()', 'pack_purchases_set_is_primary_drop()');
