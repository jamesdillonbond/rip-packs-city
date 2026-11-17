-- audit_20260823_retire_dead_fcl_wallet_auth_objects
--
-- Closes the DB follow-up deferred by known-issues #0 on 2026-08-08, when the
-- FCL wallet-connect surface was deleted from the tree. That bullet's deferral
-- condition ("after the deploy is READY") has been met for two weeks.
--
-- 🚨 THE DROP LIST IN THAT BULLET IS INCOMPLETE, AND FOLLOWING IT LITERALLY
--    BREAKS A LIVE JOB. It names three objects — `fcl_auth_nonces`, the
--    `purge_old_fcl_auth_nonces` job, and the `verify_wallet_via_fcl` RPC. It
--    does not name the caller that makes the order matter:
--
--      pg_cron `rpc-weekly-log-purges`
--        └─ run_weekly_log_purges()
--             └─ purge_old_fcl_auth_nonces(7)
--                  └─ DELETE FROM public.fcl_auth_nonces
--
--    `run_weekly_log_purges()` also purges TEN other tables — `pipeline_runs`,
--    `debug_logs`, `fmv_phantom_attempts`, three failure tables,
--    `smoke_test_results`, `usage_events`, `wallet_holdings_snapshots`,
--    `support_conversations`. Dropping the table first makes
--    `purge_old_fcl_auth_nonces` raise 42P01, which propagates out of
--    `run_weekly_log_purges` **before** its `log_pipeline_run` call at the end.
--    ⚠ So the whole weekly purge would stop AND WRITE NO ROW — it presents as
--    SILENCE, not as failure, and `pipeline_runs` retention is one of the things
--    that stops. That is why the order below is not cosmetic.
--
--    Third missed dependency: `supabase/tests/purge_old_fcl_auth_nonces.sql` is a
--    registered DB-invariant pin (`__tests__/db-invariants-drift-guard.test.ts`
--    PINS). Dropping the function while that pin stands reddens CI.
--
-- ── APPLY ORDER (the repo half goes FIRST, deliberately) ────────────────────
--   1. Push the repo commit that deletes the pin file and its PINS entry.
--      ⚠ This direction is safe in BOTH intermediate states: the guard only
--      fails when the function is missing while the pin still exists. Pin gone
--      + function still present = the guard simply does not check it.
--   2. THEN apply this migration.
--   Doing it the other way round reddens main for the length of the gap.
--
-- ── CALLERS ENUMERATED (the six-source rule), measured 2026-08-23 ───────────
--   pg_proc.prosrc      → 2: purge_old_fcl_auth_nonces, run_weekly_log_purges
--   pg_views.definition → 0
--   cron.job.command    → 0 reference `fcl` directly (the reach is via
--                         run_weekly_log_purges, which is why prosrc matters)
--   pg_trigger          → 0 on the table
--   inbound FKs         → 0
--   full-repo grep      → 1, the drift-guard PINS entry above
--
-- ── STATE ───────────────────────────────────────────────────────────────────
--   fcl_auth_nonces: 0 rows. known-issues #0 records "1 row ever minted, 0
--   consumed"; the weekly purge has since removed it. No data is lost here.
--   Privileges: `verify_wallet_via_fcl` and `purge_old_fcl_auth_nonces` are
--   service_role-only (anon/authenticated EXECUTE both false), so this is NOT
--   closing a live anon surface — it is removing dead weight. The TABLE is
--   anon/authenticated SELECT-able with RLS on, over zero rows.
--
-- Revert (in reverse order):
--   1. Re-create the table + both functions from
--      supabase/migrations/20260517140000_backfill_pack_pull_source_rip_id_and_nonces_cleanup.sql
--      (fcl_auth_nonces, purge_old_fcl_auth_nonces, and the ORIGINAL
--      run_weekly_log_purges body, which still carries the nonce leg), and
--      verify_wallet_via_fcl from its own migration.
--   2. Restore supabase/tests/purge_old_fcl_auth_nonces.sql and its PINS entry.

-- STEP 1 — remove the nonce leg from the weekly purge BEFORE anything is
-- dropped, so there is no window in which the cron calls a missing function.
-- Everything else in this body is byte-identical to the deployed version.
CREATE OR REPLACE FUNCTION public.run_weekly_log_purges()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_pipeline_runs_deleted integer;
  v_debug_logs_deleted integer;
  v_phantom_deleted integer;
  v_serial_failures_deleted integer;
  v_special_serial_failures_deleted integer;
  v_unmapped_failures_deleted integer;
  v_smoke_results_deleted integer;
  v_usage_events_deleted integer;
  v_snapshots_deleted integer;
  v_support_conversations_deleted integer;
BEGIN
  PERFORM set_config('statement_timeout', '120000', true);

  v_pipeline_runs_deleted             := public.purge_old_pipeline_runs();
  v_debug_logs_deleted                := public.purge_old_debug_logs();
  v_phantom_deleted                   := public.purge_old_fmv_phantom_attempts();
  v_serial_failures_deleted           := public.purge_old_sales_serial_backfill_failures();
  v_special_serial_failures_deleted   := public.purge_old_special_serial_lookup_failures();
  v_unmapped_failures_deleted         := public.purge_old_unmapped_resolution_failures();
  v_smoke_results_deleted             := public.purge_old_smoke_test_results();
  v_usage_events_deleted              := public.purge_old_usage_events(31);
  v_snapshots_deleted                 := public.purge_old_wallet_holdings_snapshots(90);
  v_support_conversations_deleted     := public.purge_old_support_conversations(90);
  -- fcl_auth_nonces leg removed 2026-08-23: the table and its purge function are
  -- dropped below. ⚠ The `fcl_auth_nonces_deleted` key is gone from both the
  -- pipeline_runs `extra` payload and the return value. Verified before removal
  -- that nothing reads it: repo-wide grep finds it only in the ORIGINAL 05-17
  -- migration, and `/api/admin/pipeline-health` keys on the pipeline NAME
  -- ('weekly-db-maintenance', 7-day drift threshold), not on any extra key.

  PERFORM public.log_pipeline_run(
    p_pipeline := 'weekly-db-maintenance',
    p_started_at := v_started,
    p_rows_written := v_pipeline_runs_deleted + v_debug_logs_deleted
                    + v_phantom_deleted + v_serial_failures_deleted
                    + v_special_serial_failures_deleted + v_unmapped_failures_deleted
                    + v_smoke_results_deleted + v_usage_events_deleted
                    + v_snapshots_deleted + v_support_conversations_deleted,
    p_extra := jsonb_build_object(
      'pipeline_runs_deleted',           v_pipeline_runs_deleted,
      'debug_logs_deleted',              v_debug_logs_deleted,
      'phantom_attempts_deleted',        v_phantom_deleted,
      'serial_failures_deleted',         v_serial_failures_deleted,
      'special_serial_failures_deleted', v_special_serial_failures_deleted,
      'unmapped_failures_deleted',       v_unmapped_failures_deleted,
      'smoke_results_deleted',           v_smoke_results_deleted,
      'usage_events_deleted',            v_usage_events_deleted,
      'snapshots_deleted',               v_snapshots_deleted,
      'support_conversations_deleted',   v_support_conversations_deleted
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'pipeline_runs_deleted',           v_pipeline_runs_deleted,
    'debug_logs_deleted',              v_debug_logs_deleted,
    'phantom_attempts_deleted',        v_phantom_deleted,
    'serial_failures_deleted',         v_serial_failures_deleted,
    'special_serial_failures_deleted', v_special_serial_failures_deleted,
    'unmapped_failures_deleted',       v_unmapped_failures_deleted,
    'smoke_results_deleted',           v_smoke_results_deleted,
    'usage_events_deleted',            v_usage_events_deleted,
    'snapshots_deleted',               v_snapshots_deleted,
    'support_conversations_deleted',   v_support_conversations_deleted,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer
  );
END;
$fn$;

-- Privileges re-asserted rather than assumed (CREATE OR REPLACE preserves the
-- ACL, but a replace that silently lost EXECUTE is how /api/ready broke for
-- eight days — deep-audit R44). Measured before: anon false, authenticated
-- false, service_role true.
REVOKE ALL ON FUNCTION public.run_weekly_log_purges() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_weekly_log_purges() TO service_role;

-- STEP 2 — now nothing calls it.
DROP FUNCTION IF EXISTS public.purge_old_fcl_auth_nonces(integer);

-- STEP 3 — the dead wallet-verification RPC. Service_role-only; the FCL
-- verification path it served was deleted from the tree 2026-08-08 and never
-- produced a single verified wallet (saved_wallets.verification_method has ZERO
-- fcl_* rows).
DROP FUNCTION IF EXISTS public.verify_wallet_via_fcl(uuid, text, text);

-- STEP 4 — the table. 0 rows, 0 inbound FKs, 0 triggers, 0 views.
DROP TABLE IF EXISTS public.fcl_auth_nonces;
