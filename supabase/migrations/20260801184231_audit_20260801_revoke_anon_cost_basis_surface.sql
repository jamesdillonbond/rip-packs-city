-- ============================================================================
-- audit_20260801_revoke_anon_cost_basis_surface   (F-2, P1)
--
-- WHAT WAS EXPOSED
--   public.moment_acquisitions — per-wallet cost basis / P&L — was readable by
--   the anon role via PostgREST (/rest/v1/moment_acquisitions), through policy
--   `public_read_moment_acquisitions` (SELECT, role `public`, qual=true) PLUS
--   the default Supabase anon/authenticated SELECT grant. Sensitive columns:
--   buy_price, fmv_at_acquisition, seller_address, acquisition_method,
--   loan_principal.
--   This directly contradicts proxy.ts (~line 328), which states:
--     "cost-basis-summary is intentionally NOT here — spend/P-L is private
--      (owner-only, stays auth-gated)."
--   The HTTP route was gated; the DATA was not. Route-gating != data-gating.
--
-- EVIDENCE (live, measured 2026-08-01 before this migration)
--   SET ROLE anon; SELECT count(*) FROM public.moment_acquisitions;
--     -> READABLE, 790,801 rows   (89,117 rows carry a real buy_price;
--                                  7,627 distinct wallets)
--   has_table_privilege('anon','public.moment_acquisitions','SELECT')  = true
--   has_table_privilege('authenticated', ... )                          = true
--   Also revoked from `authenticated`: the front door is OPEN (self-serve
--   magic-link signup since 2026-07-20), so "authenticated" is any member of
--   the public who signs up, and no RLS scopes these rows to their owner —
--   leaving the authenticated grant would make the anon revoke trivially
--   bypassable by registering an account.
--
-- WHAT WAS VERIFIED BEFORE REVOKING (3-part protocol)
--   1. DIRECT CALLER SWEEP — every in-repo reader of moment_acquisitions and
--      of the 4 cost-basis functions resolves to the SERVICE-ROLE client. The
--      identifier `supabase` is NOT the anon client in any of them:
--        - app/api/cost-basis, cost-basis-backfill, cost-basis-gql-backfill,
--          cache-refresh, wallet-summary, migrate-acquired-at
--            -> local createClient(url, SUPABASE_SERVICE_ROLE_KEY) named `supabase`
--        - app/api/profile/{cost-basis-summary,export-csv,watchlist}
--            -> `import { supabaseAdmin as supabase }`
--        - wallet-search, wallet-hold-time, wallet-cost-basis, classify-unknowns,
--          bulk-classify, pack-listings/historical-pulls, marketplace-breakdown,
--          acquisition-stats, collection-moments, analytics, pinnacle-ingest
--            -> supabaseAdmin
--        - scripts/backfill-purchase-prices.mjs, scripts/local-cost-basis-backfill.mjs
--            -> raw /rest/v1 fetch with apikey = SUPABASE_SERVICE_ROLE_KEY
--      lib/supabase.ts DOES export an anon client named `supabase`, but it has
--      ZERO named-import sites across app/ lib/ components/, and components/
--      + lib/auth/ make ZERO .rpc() calls — the browser reaches data only via
--      /api/* routes.
--   2. INVOKER-CALLER SWEEP (the trap that makes a direct sweep insufficient) —
--      enumerated every view/function that reads moment_acquisitions and is
--      itself anon/authenticated-reachable, since SECURITY INVOKER executes as
--      the CALLER and would keep the anon grant load-bearing:
--        - VIEW v_topshot_edition_pull_provenance (security_invoker=true,
--          anon-SELECTable) -> sole consumer is the edition detail page,
--          app/(collections)/[collection]/edition/[slug]/page.tsx, whose
--          rpcClient() returns `supabaseAdmin` (service role). NOT load-bearing.
--          The view exposes only edition-level aggregates (no wallet, no price).
--        - VIEW pipeline_health (security_invoker, authenticated-SELECTable) ->
--          zero in-repo consumers (the analytics surfaces call the separate
--          analytics_pipeline_health() RPC, not this view). NOT load-bearing.
--        - FN get_wallet_summary / get_wallet_moments_with_fmv (SECURITY
--          INVOKER, anon-EXECUTE, bodies read moment_acquisitions.buy_price) ->
--          all callers service-role: /api/wallet-summary builds its own
--          createClient(SERVICE_ROLE_KEY) named `supabase`; collection-moments,
--          analytics, pinnacle-wallet, portfolio-export use supabaseAdmin.
--          NOT load-bearing. Their anon EXECUTE grants are left UNTOUCHED here.
--      No pg_cron job references moment_acquisitions (cron.job sweep = 0 rows).
--   3. PUBLIC-ROUTE SWEEP — proxy.ts isPublicPath: /api/marketplace-breakdown,
--      /api/collection-moments, /api/wallet-summary and the /api/analytics
--      subtree ARE anon-reachable, but every one reads through the service-role
--      client, so none depends on the anon grant.
--
--   service_role and postgres retain explicit grants + the
--   service_role_all_moment_acquisitions policy, so all ingest/read paths above
--   are unaffected.
--
-- REVERT SQL (exact)
--   GRANT SELECT ON public.moment_acquisitions TO anon, authenticated;
--   CREATE POLICY public_read_moment_acquisitions ON public.moment_acquisitions
--     FOR SELECT TO public USING (true);
-- ============================================================================

REVOKE SELECT ON public.moment_acquisitions FROM anon, authenticated;

DROP POLICY IF EXISTS public_read_moment_acquisitions ON public.moment_acquisitions;

COMMENT ON TABLE public.moment_acquisitions IS
  'Per-wallet cost basis / P&L (buy_price, fmv_at_acquisition, seller_address, '
  'loan_principal). PRIVATE: service-role only. anon + authenticated SELECT '
  'revoked 2026-08-01 (audit_20260801_revoke_anon_cost_basis_surface) — it was '
  'anon-readable (790,801 rows) contradicting the owner-only spend/P&L stance '
  'in proxy.ts. Read it only via supabaseAdmin. Do NOT re-add a qual=true '
  'policy or a per-role SELECT grant.';