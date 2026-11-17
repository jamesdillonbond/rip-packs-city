-- audit_20260822_readiness_collection_stats_and_r14_search_path
--
-- Two unrelated changes batched into ONE migration on purpose: every
-- `apply_migration` costs a ~10–20 s burst of user-facing PGRST002 500s from
-- schema-cache re-introspection, so the R14 ALTERs — which buy zero exposure
-- reduction on their own and were deliberately parked for "the next real DDL
-- window" — ride along with the R44 fix rather than paying that burst twice.
--
-- ── PART 1 — deep-audit R44: /api/ready has 500'd since 2026-08-15 ──────────
--
-- ⚠ THE OBVIOUS FIX IS INVERTED. The route 500s because `anon` lost EXECUTE on
-- `health_check()`, and it is tempting to read that as collateral damage from a
-- privilege sweep and simply put the grant back. DO NOT. `health_check()` is
-- SECURITY DEFINER and returns `users` (auth_users, active_7d, user_profiles,
-- saved_wallets, active_allowed), `telemetry` (total_events, distinct_wallets,
-- distinct_features), `insider_signals` and `db_size_mb`; `app/api/ready/route.ts`
-- spreads the WHOLE payload (`{ ...data, per_collection, … }`) and the route is
-- anon-reachable via PUBLIC_READ_APIS. Until 2026-08-15 an unauthenticated GET
-- published every one of those figures to anyone who asked. The revoke CLOSED a
-- real anon data leak. It stays closed.
--
-- ⚠ AND THE GRANT WAS NEVER THE WHOLE STORY. Restoring it would not have fixed
-- the route either: `health_check()` returns `collections` as a
-- `json_object_agg` keyed by slug, and the route calls `.map()` on it, which is
-- a TypeError on an object. There is also no `fmv_pipeline`, `data_integrity`,
-- `sales_pipeline` or `listing_cache` key in the deployed function at all — the
-- route was written against a shape the DB does not return. `__tests__/
-- api-ready.test.ts` is green because it MOCKS that invented payload, so nothing
-- in CI compares the mock to the live function. Two independent faults, one
-- symptom; only the second is visible from the code.
--
-- The fix is a purpose-built RPC that returns ONLY the slice the three
-- consumers actually read — `/[collection]/market` and `/[collection]/analytics`
-- use `per_collection[].slug` and `.sales_24h` and nothing else — and never the
-- users / telemetry / db_size legs.
--
-- ⚠ SECURITY INVOKER, NOT DEFINER, and that is load-bearing. `sales` is
-- RLS-readable by PUBLIC with `USING (true)` and `collections` with
-- `USING (is_active IS TRUE)`, which is exactly this function's own filter, so
-- an INVOKER function publishes nothing anon could not already page out of
-- PostgREST row by row. A DEFINER version would work identically today and
-- would ALSO land in `check_secdef_anon_exec_drift()` as a new anon-executable
-- definer function — a permanent auditing cost bought for no capability.
--
-- Cost, measured warm-vs-warm (a cold read of the same plan took 2,580 ms and
-- is not the number to quote): 10.9 ms / 3,907 buffers, all shared hits, via
-- `idx_sales_2026_collid_soldat_cover` with the 6 non-matching partitions
-- pruned. That is a large net REDUCTION against `health_check()`, which counted
-- all of `usage_events`, all of `auth.users`, `moment_acquisitions` and the
-- full `sales` history per collection on every anon page load.
--
-- Revert: DROP FUNCTION public.readiness_collection_stats();
--         (and revert app/api/ready/route.ts — the route requires this function)

CREATE OR REPLACE FUNCTION public.readiness_collection_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'slug',         c.slug,
        'name',         c.name,
        'sales_24h',    (SELECT count(*)     FROM public.sales s
                          WHERE s.collection_id = c.id
                            AND s.sold_at > now() - interval '24 hours'),
        'last_sale_at', (SELECT max(s.sold_at) FROM public.sales s
                          WHERE s.collection_id = c.id
                            AND s.sold_at > now() - interval '7 days')
      )
      ORDER BY c.slug
    ),
    '[]'::jsonb
  )
  FROM public.collections c
  WHERE c.is_active = true;
$$;

COMMENT ON FUNCTION public.readiness_collection_stats() IS
  'Anon-safe readiness slice for /api/ready: per-collection sales_24h + last_sale_at only. Deliberately SECURITY INVOKER — it reads nothing anon cannot already SELECT under RLS. ⛔ Do not widen it to carry user counts, telemetry or db_size; that is the leak deep-audit R44 closed.';

-- This DB carries BOTH a PUBLIC default and ALTER DEFAULT PRIVILEGES grants, so
-- neither revoke alone is sufficient — revoke all three in one statement, then
-- grant back exactly the two roles that need it.
REVOKE ALL ON FUNCTION public.readiness_collection_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_collection_stats() TO anon, authenticated, service_role;

-- Record the reason on `health_check` itself, where the next person to wonder
-- why /api/ready lost its grant will actually be standing. A comment in a
-- migration is only read by someone already reading migrations.
COMMENT ON FUNCTION public.health_check() IS
  '⛔ DO NOT GRANT EXECUTE TO anon OR authenticated. SECURITY DEFINER, and returns user counts, saved-wallet counts, allow-list size, telemetry volume, distinct wallets and db_size_mb. It was anon-executable until 2026-08-15 and /api/ready spread the whole payload to unauthenticated callers (deep-audit R44). Anon readiness now goes through public.readiness_collection_stats(). service_role only.';

-- ── PART 2 — deep-audit R14: two function_search_path_mutable advisor WARNs ──
--
-- Both are PROCEDURES, both SECURITY INVOKER (`prosecdef = false`, so there is
-- no definer privilege to hijack), `proconfig` NULL, and EXECUTE is false for
-- anon AND authenticated. Verified harmless; this clears the advisor.
--
-- ⚠ ALTER, never CREATE OR REPLACE. Re-declaring the body is exactly how a
-- procedure silently acquires a SECURITY DEFINER it never had.
--
-- Revert: ALTER PROCEDURE ... RESET search_path;  (on both)

ALTER PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer, integer)
  SET search_path = public;

ALTER PROCEDURE public.rpc_trust_health_precompute_refresh_p()
  SET search_path = public;
