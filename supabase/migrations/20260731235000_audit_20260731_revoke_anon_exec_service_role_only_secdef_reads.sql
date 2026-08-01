-- audit_20260731_revoke_anon_exec_service_role_only_secdef_reads
--
-- Third and final pass on the 2026-07-31 SECDEF exec-surface audit.
--
-- The round-6 handoff flagged these as "worth a glance" -- they expose
-- targeting/maintenance output or the agent surface rather than product
-- surface. Verified for each: EVERY caller uses the service role, no DB-side
-- function references it, and no pg_cron job invokes it. So the anon /
-- authenticated grants are unused reachability.
--
--   get_stale_ownership_wallets(int)  <- app/api/cron/ownership-onchain-walk (supabaseAdmin)
--   topshot_wmc_fossil_targets(int)   <- app/api/admin/drain-topshot-misattribution (supabaseAdmin)
--   get_allday_unresolved_pulls(int)  <- NO caller at all (docs mention only)
--   mcp_get_fmv / mcp_compute_pack_ev / mcp_get_badge_data / mcp_find_set_completion
--                                     <- workers/rpc-mcp-proxy, which calls PostgREST with
--                                        SUPABASE_SERVICE_ROLE_KEY (verified index.ts:236-237)
--
-- Per CLAUDE.md: "For a SECDEF fn only reached by service_role clients
-- (supabaseAdmin) or by other SECDEF fns, REVOKE rather than allowlist -- the
-- drift check only flags fns that ARE anon/auth-executable, so removing the
-- grant clears it and shrinks the anon surface."
--
-- Bodies are untouched, so the mcp_get_fmv SQL invariant pin + its drift guard
-- are unaffected.
REVOKE EXECUTE ON FUNCTION public.get_stale_ownership_wallets(integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.topshot_wmc_fossil_targets(integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_allday_unresolved_pulls(integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mcp_get_fmv(text, text, integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mcp_compute_pack_ev(text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mcp_get_badge_data(text, text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mcp_find_set_completion(text, text, text) FROM anon, authenticated, PUBLIC;

-- Retire their now-dead acceptance rows (same reasoning as the prior pass).
DELETE FROM public.secdef_anon_exec_allowlist
WHERE identity IN (
  'get_stale_ownership_wallets(integer)',
  'topshot_wmc_fossil_targets(integer)',
  'get_allday_unresolved_pulls(integer)',
  'mcp_get_fmv(text,text,integer)',
  'mcp_compute_pack_ev(text)',
  'mcp_get_badge_data(text,text)',
  'mcp_find_set_completion(text,text,text)'
);
