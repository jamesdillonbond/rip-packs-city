-- audit_secdef_anon_exec_revocations
--
-- SECURITY DEFINER + EXECUTE-to-anon hardening, batch 1.
--
-- Background
-- ----------
-- Audit of public schema turned up 14 SECURITY DEFINER functions owned by
-- the postgres role (rolbypassrls=true) with EXECUTE granted to anon and
-- authenticated.  Any caller carrying the publishable anon key can invoke
-- them, and because the function runs as postgres, it bypasses RLS on the
-- tables it touches.
--
-- This migration narrows the surface for the subset that have NO browser /
-- anon caller anywhere in the repository — they are reachable only via
-- Vercel API routes using `supabaseAdmin` (SUPABASE_SERVICE_ROLE_KEY) or
-- via Supabase Edge Functions / scripts also using SERVICE_ROLE_KEY.
-- service_role already bypasses RLS via BYPASSRLS, so it does not need
-- an EXECUTE grant routed through anon/authenticated.  Revoking those
-- grants closes the unauthenticated-RPC path without touching legitimate
-- callers.
--
-- Hard exclusions (intentionally NOT in this migration)
-- -----------------------------------------------------
--   * public.query_sql(text)
--       Only repo caller is app/api/fmv-recalc/route.ts (server-side,
--       supabaseAdmin), so functionally it is "Bucket B".  But its body is
--       EXECUTE format($q$ ... FROM (%s) t $q$, query) — a fully general
--       SELECT-evaluator.  The blast radius if any cron / external tool /
--       Studio bookmark also calls it is too large to revoke without
--       Trevor reviewing first.  Trevor handles this one separately.
--
--   * Bucket-D set (8 functions) — no repo caller, but plausibly invoked
--     by pg_cron, trigger, Supabase Studio, or out-of-tree ops scripts.
--     Listed in the trailing comment block for follow-up; not revoked
--     and not dropped here.
--
-- Apply path
-- ----------
-- DO NOT mcp__supabase__apply_migration this file from automation.
-- Trevor applies via Supabase dashboard SQL editor after eyeballing each
-- REVOKE.  The migration is committed so the change is tracked, but the
-- DB state should only move when Trevor pastes this SQL.
--
-- Audit evidence (call sites are all service-role / server-side):
--   activate_pro_from_payment        app/api/pro-activate/route.ts
--   save_user_wallet                 app/api/wallet/save/route.ts
--   upsert_wallet_moments            app/api/wallet/seed/route.ts
--   pinnacle_upsert_nft_map          supabase/functions/pinnacle-nft-resolver/index.ts
--   backfill_pinnacle_sale_editions  supabase/functions/pinnacle-nft-resolver/index.ts
--                                    scripts/backfill-pinnacle-editions.ts

BEGIN;

-- ── Static-signature revokes ─────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.save_user_wallet(text, text, text, text)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.upsert_wallet_moments(text, uuid, jsonb)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.pinnacle_upsert_nft_map(text, text, text)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.backfill_pinnacle_sale_editions()
  FROM anon, authenticated;

-- ── Dynamic revoke for activate_pro_from_payment ─────────────────────
-- The Vercel route names 4 args (p_sender_wallet, p_moment_nft_id,
-- p_fmv, p_duration_days) but the live definition may include
-- additional defaulted parameters (e.g. p_plan).  REVOKE wants an exact
-- identity-arguments string, so we look it up at apply time and revoke
-- every overload of the name in public.
DO $$
DECLARE
  fn_args text;
BEGIN
  FOR fn_args IN
    SELECT pg_get_function_identity_arguments(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'activate_pro_from_payment'
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION public.activate_pro_from_payment(%s) FROM anon, authenticated',
      fn_args
    );
  END LOOP;
END
$$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- Bucket C (drop candidates) — NONE in this batch.
--
-- Every SECURITY DEFINER function with zero in-repo caller was
-- conservatively classified as Bucket D rather than Bucket C, because
-- the names strongly suggest external invocation paths that grep
-- cannot see (pg_cron jobs, trigger bodies, Studio bookmarks, ops
-- scripts kept outside this repo).  Trevor: confirm the channel for
-- each before deciding revoke-vs-drop.
--
--   prune_pipeline_runs(int)
--     -> likely pg_cron maintenance (rolling-window pruner).
--        Verify with: SELECT * FROM cron.job WHERE command ILIKE '%prune_pipeline_runs%';
--
--   purge_old_pipeline_runs()
--     -> likely pg_cron maintenance.
--        Verify with: SELECT * FROM cron.job WHERE command ILIKE '%purge_old_pipeline_runs%';
--
--   purge_old_debug_logs()
--     -> likely pg_cron maintenance.
--        Verify with: SELECT * FROM cron.job WHERE command ILIKE '%purge_old_debug_logs%';
--
--   run_weekly_db_maintenance()
--     -> "weekly" in the name = almost certainly pg_cron entrypoint.
--        Verify with: SELECT * FROM cron.job WHERE command ILIKE '%run_weekly_db_maintenance%';
--
--   pinnacle_upsert_nft_map_batch(jsonb)
--     -> pinnacle resolver currently calls the singular pinnacle_upsert_nft_map
--        per-row.  Batch wrapper looks like a planned optimization that has
--        not been wired up yet; could also be invoked from out-of-tree
--        backfill tooling.  Confirm before dropping.
--
--   backfill_missing_pinnacle_editions()
--     -> ad-hoc backfill helper; may be run by hand from Studio when
--        a wave of pinnacle_sales rows lands without edition_id.
--
--   classify_acquisition(text, text, text, text, numeric)
--     -> matches the shape of a row-level classifier; check whether any
--        AFTER INSERT trigger references it before revoking/dropping.
--        Verify with:
--          SELECT tgname, tgrelid::regclass FROM pg_trigger
--          WHERE tgfoid = 'public.classify_acquisition'::regproc;
--
--   rebuild_flowty_loans(bigint[])
--     -> migration 20260427030000_harden_search_path_analytics_rpcs.sql
--        explicitly notes this "just landed 2026-04-27 01:37 UTC" and is
--        deferred from search_path hardening because the work stream is
--        still active.  Same caller-channel uncertainty applies here.
-- ─────────────────────────────────────────────────────────────────────
