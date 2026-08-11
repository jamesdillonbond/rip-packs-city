-- ============================================================================
-- audit_20260801_revoke_anon_exec_volatile_writers   (F-7, P3)
--
-- WHAT WAS EXPOSED
--   Six VOLATILE (write-capable) function signatures were EXECUTE-able by the
--   anon role. All are SECURITY INVOKER, so their writes currently fail against
--   anon's own RLS — but EXECUTE itself was reachable unauthenticated:
--     public.compute_price_snapshots()
--     public.compute_price_snapshots(interval)
--     public.backfill_cost_basis_from_ids(text, text[], uuid)
--     public.bulk_insert_pinnacle_sales(json)
--     public.seed_topshot_editions(text[])
--     public.upsert_pinnacle_edition(text,text,text,text,text,text,integer,text,
--       text,integer,integer,boolean,boolean,text[],text[],text,text,text,
--       timestamptz,text)
--   The material risk is compute_price_snapshots(): argument-free, unauthenticated,
--   and an expensive aggregate over the partitioned `sales` table — i.e. a free
--   DB-CPU/IOPS exhaustion lever on an IOPS-constrained Micro instance, callable
--   by anyone at /rest/v1/rpc/compute_price_snapshots with only the publishable
--   anon key.
--
-- EVIDENCE (live, measured 2026-08-01 before this migration)
--   has_function_privilege('anon', <sig>, 'EXECUTE') = true for all six.
--   proacl showed the DEFAULT PUBLIC grant `=X/postgres` present on five of the
--   six (seed_topshot_editions had explicit anon/authenticated grants instead),
--   which is why this migration revokes FROM PUBLIC as well as from the named
--   roles: a role-only REVOKE leaves has_function_privilege('anon', ...) TRUE
--   via the surviving PUBLIC grant.
--
-- WHAT WAS VERIFIED BEFORE REVOKING
--   1. DIRECT CALLER SWEEP — every caller resolves to the SERVICE-ROLE client:
--        backfill_cost_basis_from_ids -> app/api/cost-basis-backfill/route.ts,
--          local createClient(url, SUPABASE_SERVICE_ROLE_KEY) named `supabase`
--        bulk_insert_pinnacle_sales   -> app/api/pinnacle-ingest/route.ts, supabaseAdmin
--        upsert_pinnacle_edition      -> app/api/pinnacle-ingest/route.ts, supabaseAdmin
--        seed_topshot_editions        -> supabase/functions/compute-topshot-pack-ev,
--          createClient(..., Deno.env SUPABASE_SERVICE_ROLE_KEY)
--        compute_price_snapshots      -> NO CALLER ANYWHERE. Repo-wide grep returns
--          only the 2026-04-27 search_path-hardening migration (a comment + an
--          ALTER FUNCTION), no invocation in app/, lib/, workers/, supabase/
--          functions/, scripts/, .github/ or vercel.json.
--   2. INVOKER-CALLER SWEEP — the only DB function whose body references any of
--      these is remap_pack_pool_uuid_key(text,text), which is SECURITY DEFINER
--      and is itself NOT anon-executable, so it runs as its definer (postgres)
--      and is unaffected by an anon EXECUTE revoke on the callee.
--   3. SCHEDULER SWEEP — cron.job contains no reference to any of the six
--      (0 rows), so no pg_cron entry depends on these grants.
--
--   postgres (owner) and service_role hold explicit EXECUTE grants
--   (postgres=X/postgres, service_role=X/postgres) which survive a PUBLIC
--   revoke, so every caller above keeps working.
--
-- REVERT SQL (exact)
--   GRANT EXECUTE ON FUNCTION public.compute_price_snapshots() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.compute_price_snapshots(interval) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.backfill_cost_basis_from_ids(text, text[], uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.bulk_insert_pinnacle_sales(json) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.seed_topshot_editions(text[]) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.upsert_pinnacle_edition(text,text,text,text,text,text,integer,text,text,integer,integer,boolean,boolean,text[],text[],text,text,text,timestamptz,text) TO anon, authenticated;
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.compute_price_snapshots()
  FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.compute_price_snapshots(interval)
  FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.backfill_cost_basis_from_ids(text, text[], uuid)
  FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bulk_insert_pinnacle_sales(json)
  FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.seed_topshot_editions(text[])
  FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_pinnacle_edition(
  text,text,text,text,text,text,integer,text,text,integer,integer,boolean,
  boolean,text[],text[],text,text,text,timestamptz,text)
  FROM anon, authenticated, PUBLIC;

COMMENT ON FUNCTION public.compute_price_snapshots() IS
  'VOLATILE aggregate over public.sales. Service-role only — anon/authenticated/'
  'PUBLIC EXECUTE revoked 2026-08-01 (audit_20260801_revoke_anon_exec_volatile_'
  'writers): it was unauthenticated + argument-free + expensive, i.e. a free '
  'DB-CPU exhaustion lever. Zero in-repo callers and zero pg_cron callers as of '
  'that date. Do NOT re-grant to anon.';