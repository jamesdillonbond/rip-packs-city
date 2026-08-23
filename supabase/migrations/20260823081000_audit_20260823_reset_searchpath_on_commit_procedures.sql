-- audit_20260823_reset_searchpath_on_commit_procedures
-- Applied to prod via Supabase MCP apply_migration 2026-08-23 ~01:10 PT (08:10Z) by rpc-nightly-autonomous-pass.
-- (NO-PUSH cloud session: this file is mirrored to the mount and UNCOMMITTED; Trevor's box + Claude Code
--  push normally via the PAT in remote.origin.pushurl — commit this file as usual. The push blocker is a
--  fact about this cloud session, not this migration.)
--
-- WHY: R14 (migration 20260823021500, 2026-08-22) attached `SET search_path = public` to two PROCEDURES
-- that perform per-wallet COMMITs. PostgreSQL forbids COMMIT/ROLLBACK inside a routine carrying an attached
-- SET clause, so both raise `2D000 invalid transaction termination` at their first COMMIT.
-- `reconcile_all_saved_wallet_stats` failed every hourly pg_cron tick (jobid 259, :44) from ~02:15Z 2026-08-23
-- onward, freezing saved-wallet dashboard/profile/share cards. `rpc_trust_health_precompute_refresh_p` carried
-- the identical latent defect. The 2026-08-10 ledger work already established these transaction-control
-- procedures must carry NO SET clause and schema-qualify internally (which their bodies do); R14's "verified
-- harmless" pre-flight (2026-08-15) missed the COMMIT-vs-SET-clause interaction. This RESTORES the
-- proven-working pre-R14 state. Config-only ALTER (not CREATE OR REPLACE): bodies + prosecdef=false preserved.
--
-- REVERT:
--   ALTER PROCEDURE public.reconcile_all_saved_wallet_stats(integer,integer,integer) SET search_path = public;
--   ALTER PROCEDURE public.rpc_trust_health_precompute_refresh_p() SET search_path = public;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname='reconcile_all_saved_wallet_stats'
      AND pronamespace='public'::regnamespace AND prokind='p'
      AND pg_get_function_identity_arguments(oid)='IN p_max_seconds integer, IN p_max_wallets integer, IN p_min_age_minutes integer'
  ) THEN RAISE EXCEPTION 'reconcile_all_saved_wallet_stats(int,int,int) procedure not found -- aborting'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname='rpc_trust_health_precompute_refresh_p'
      AND pronamespace='public'::regnamespace AND prokind='p'
      AND pg_get_function_identity_arguments(oid)=''
  ) THEN RAISE EXCEPTION 'rpc_trust_health_precompute_refresh_p() procedure not found -- aborting'; END IF;
END $$;

ALTER PROCEDURE public.reconcile_all_saved_wallet_stats(integer,integer,integer) RESET search_path;
ALTER PROCEDURE public.rpc_trust_health_precompute_refresh_p() RESET search_path;
