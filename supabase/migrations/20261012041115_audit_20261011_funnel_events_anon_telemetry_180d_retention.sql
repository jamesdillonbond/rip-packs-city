-- audit_20261011_funnel_events_anon_telemetry_180d_retention
--
-- 2026-10-11 (PT, Claude Code cloud). Platform review 2026-10-11, item C6
-- (docs/audits/platform-review-security-marketing-seo-compliance-2026-10-11.md).
--
-- WHAT. funnel_events — page views, clicks, user agent, referring page, a
-- per-browser visitor id — had NO retention: 127,707 rows since 2026-05-31
-- (127,650 anonymous) on 2026-10-11, while every sibling telemetry table is
-- purged by run_weekly_log_purges (usage_events 31 d, support_conversations
-- 90 d, wallet_holdings_snapshot 90 d). The privacy policy now states 180 days
-- for anonymous page-view telemetry; this migration is what makes that true.
--
-- SCOPE. Anonymous rows only (user_id IS NULL). Rows tied to an account are
-- account data: trophy_case_campaign_users reads trophy_pinned events by user
-- (campaign attribution since 09-27) and get_rpc_traction_snapshot joins by
-- user — both would be silently eroded by a blanket purge. Readers of the
-- anonymous rows were enumerated live before writing: admin_visitor_journeys
-- (30-day windows, plus a 30-day look-back per visitor), get_rpc_traction_snapshot
-- (7/30-day windows and max(created_at)), check_anon_write_surface (shape only).
-- None reaches past 180 days. 402 anonymous rows are older than 120 d today and
-- 0 older than 180 d, so the first run deletes nothing and later runs delete
-- roughly one week of traffic each.
--
-- COST. The delete filters on created_at + user_id IS NULL; the partial index
-- funnel_events_human_created_idx (created_at DESC WHERE bot_ua = false) does
-- not cover it, so it is a weekly scan of ~130k narrow rows inside the runner's
-- 120 s statement_timeout. Read the next weekly-db-maintenance row's
-- duration_ms before concluding anything about cost (CLAUDE.md: a correctness
-- probe is silent about cost by construction).
--
-- HOW. purge_old_funnel_events mirrors purge_old_usage_events (pinned:
-- supabase/tests/purge_old_funnel_events.sql). run_weekly_log_purges is the
-- live pg_get_functiondef body — prosrc md5 03152fd38abbc14f475d71c47480eb41
-- re-read immediately before writing this file — plus the one leg, its term in
-- rows_written, and its key in both jsonb objects. Nothing else in it changes.
--
-- ── ANON-EXECUTE DECISIONS (one line per function, name on the line) ──
-- anon-exec: revoked below — SECURITY DEFINER retention deleter, reached only from run_weekly_log_purges() (purge_old_funnel_events)
-- anon-exec: unchanged (revoked; anon=false, authenticated=false, service_role=true verified live 2026-10-11 via has_function_privilege) — CREATE OR REPLACE preserves the ACL (run_weekly_log_purges)
--
-- REVERT: re-apply the run_weekly_log_purges block from
-- supabase/migrations/20261004030511_audit_20261003_run_durations_no_longer_wrap_at_60_seconds.sql
-- (its md5-guarded splice, with the base md5 updated to this file's post-apply
-- value), then DROP FUNCTION public.purge_old_funnel_events(integer). Deleted
-- rows are anonymous telemetry older than 180 d and are not recoverable.

-- ── purge_old_funnel_events ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_old_funnel_events(p_days_keep integer DEFAULT 180)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  -- Anonymous telemetry only. Rows with a user_id are account data (the
  -- trophy-case campaign view and the traction snapshot read them by user) and
  -- live as long as the account does; the privacy policy says exactly that.
  DELETE FROM funnel_events
  WHERE created_at < NOW() - (p_days_keep || ' days')::interval
    AND user_id IS NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_old_funnel_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_funnel_events(integer) TO postgres, service_role;

-- ── run_weekly_log_purges (live body + the funnel_events leg) ──────────────
CREATE OR REPLACE FUNCTION public.run_weekly_log_purges()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_funnel_events_deleted integer;
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
  -- fcl_auth_nonces leg removed 2026-08-23; table + purge function dropped below.
  -- funnel_events leg added 2026-10-11: anonymous page-view telemetry, 180 days.
  v_funnel_events_deleted             := public.purge_old_funnel_events(180);

  PERFORM public.log_pipeline_run(
    p_pipeline := 'weekly-db-maintenance',
    p_started_at := v_started,
    p_rows_written := v_pipeline_runs_deleted + v_debug_logs_deleted
                    + v_phantom_deleted + v_serial_failures_deleted
                    + v_special_serial_failures_deleted + v_unmapped_failures_deleted
                    + v_smoke_results_deleted + v_usage_events_deleted
                    + v_snapshots_deleted + v_support_conversations_deleted
                    + v_funnel_events_deleted,
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
      'support_conversations_deleted',   v_support_conversations_deleted,
      'funnel_events_deleted',           v_funnel_events_deleted
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
    'funnel_events_deleted',           v_funnel_events_deleted,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::integer
  );
END;
$function$;
