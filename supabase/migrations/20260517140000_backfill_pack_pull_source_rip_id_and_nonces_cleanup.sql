-- backfill_pack_pull_source_rip_id(p_limit int default 1000)
-- Backfills moment_acquisitions.source_pack_rip_id for the historical pack_pull
-- rows that pre-date the FK or weren't joined at insert (6925 rows as of
-- 2026-05-17). Joins on (opener_address, time-window) where window is
-- (sealed_at - 5min, sealed_at + 30min). Returns jsonb with per-confidence
-- counts so the calling route can write pipeline_runs.extra.
CREATE OR REPLACE FUNCTION public.backfill_pack_pull_source_rip_id(
  p_limit int DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_exact int := 0;
  v_inferred int := 0;
  v_no_match int := 0;
  v_examined int := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN p_limit := 1000; END IF;

  CREATE TEMP TABLE _unlinked ON COMMIT DROP AS
  SELECT
    ma.nft_id,
    ma.wallet,
    ma.acquired_date,
    ma.transaction_hash
  FROM public.moment_acquisitions ma
  WHERE ma.acquisition_method = 'pack_pull'
    AND ma.source_pack_rip_id IS NULL
    AND ma.wallet IS NOT NULL
    AND ma.acquired_date IS NOT NULL
  ORDER BY ma.acquired_date DESC
  LIMIT p_limit;

  GET DIAGNOSTICS v_examined = ROW_COUNT;

  CREATE TEMP TABLE _candidates ON COMMIT DROP AS
  SELECT
    u.nft_id,
    u.wallet,
    u.acquired_date,
    u.transaction_hash,
    pr.id AS rip_id,
    pr.sealed_at,
    ABS(EXTRACT(EPOCH FROM (pr.sealed_at - u.acquired_date))) AS time_delta_secs,
    COUNT(*) OVER (PARTITION BY u.nft_id, u.wallet, u.acquired_date) AS match_count
  FROM _unlinked u
  JOIN public.pack_rips pr
    ON pr.opener_address = u.wallet
   AND pr.sealed_at BETWEEN u.acquired_date - INTERVAL '5 minutes'
                         AND u.acquired_date + INTERVAL '30 minutes';

  CREATE TEMP TABLE _picks ON COMMIT DROP AS
  SELECT DISTINCT ON (nft_id, wallet, acquired_date)
    nft_id,
    wallet,
    acquired_date,
    transaction_hash,
    rip_id,
    match_count,
    CASE WHEN match_count = 1 THEN 'exact_match' ELSE 'inferred' END AS confidence
  FROM _candidates
  ORDER BY nft_id, wallet, acquired_date, time_delta_secs ASC;

  WITH applied AS (
    UPDATE public.moment_acquisitions ma
       SET source_pack_rip_id = p.rip_id
      FROM _picks p
     WHERE ma.nft_id = p.nft_id
       AND ma.wallet = p.wallet
       AND ma.acquired_date = p.acquired_date
       AND ma.acquisition_method = 'pack_pull'
       AND ma.source_pack_rip_id IS NULL
    RETURNING p.confidence
  )
  SELECT
    COUNT(*) FILTER (WHERE confidence = 'exact_match'),
    COUNT(*) FILTER (WHERE confidence = 'inferred')
  INTO v_exact, v_inferred
  FROM applied;

  v_no_match := v_examined - v_exact - v_inferred;

  RETURN jsonb_build_object(
    'ok', true,
    'examined', v_examined,
    'exact_match', v_exact,
    'inferred', v_inferred,
    'no_match', v_no_match,
    'limit', p_limit,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::int
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.backfill_pack_pull_source_rip_id(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backfill_pack_pull_source_rip_id(int) FROM anon;
REVOKE ALL ON FUNCTION public.backfill_pack_pull_source_rip_id(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_pack_pull_source_rip_id(int) TO postgres, service_role;


CREATE OR REPLACE FUNCTION public.purge_old_fcl_auth_nonces(
  retention_days int DEFAULT 7
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM public.fcl_auth_nonces
   WHERE expires_at IS NOT NULL
     AND expires_at < now() - (retention_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_old_fcl_auth_nonces(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_old_fcl_auth_nonces(int) FROM anon;
REVOKE ALL ON FUNCTION public.purge_old_fcl_auth_nonces(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_fcl_auth_nonces(int) TO postgres, service_role;


CREATE OR REPLACE FUNCTION public.run_weekly_db_maintenance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_pipeline_runs_deleted integer;
  v_debug_logs_deleted integer;
  v_stale_cache_deleted integer;
  v_phantom_deleted integer;
  v_serial_failures_deleted integer;
  v_special_serial_failures_deleted integer;
  v_unmapped_failures_deleted integer;
  v_smoke_results_deleted integer;
  v_usage_events_deleted integer;
  v_snapshots_deleted integer;
  v_support_conversations_deleted integer;
  v_nonces_deleted integer;
BEGIN
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
  v_nonces_deleted                    := public.purge_old_fcl_auth_nonces(7);

  DELETE FROM public.wallet_moments_cache
  WHERE last_seen_at < now() - interval '14 days'
    AND NOT EXISTS (
      SELECT 1 FROM seeded_wallets sw
      WHERE sw.wallet_address = wallet_moments_cache.wallet_address
        AND sw.is_active = true
    );
  GET DIAGNOSTICS v_stale_cache_deleted = ROW_COUNT;

  PERFORM public.log_pipeline_run(
    p_pipeline := 'weekly-db-maintenance',
    p_started_at := v_started,
    p_rows_written := v_pipeline_runs_deleted + v_debug_logs_deleted + v_stale_cache_deleted
                    + v_phantom_deleted + v_serial_failures_deleted
                    + v_special_serial_failures_deleted + v_unmapped_failures_deleted
                    + v_smoke_results_deleted + v_usage_events_deleted
                    + v_snapshots_deleted + v_support_conversations_deleted
                    + v_nonces_deleted,
    p_extra := jsonb_build_object(
      'pipeline_runs_deleted',           v_pipeline_runs_deleted,
      'debug_logs_deleted',              v_debug_logs_deleted,
      'stale_cache_deleted',             v_stale_cache_deleted,
      'phantom_attempts_deleted',        v_phantom_deleted,
      'serial_failures_deleted',         v_serial_failures_deleted,
      'special_serial_failures_deleted', v_special_serial_failures_deleted,
      'unmapped_failures_deleted',       v_unmapped_failures_deleted,
      'smoke_results_deleted',           v_smoke_results_deleted,
      'usage_events_deleted',            v_usage_events_deleted,
      'snapshots_deleted',               v_snapshots_deleted,
      'support_conversations_deleted',   v_support_conversations_deleted,
      'fcl_auth_nonces_deleted',         v_nonces_deleted,
      'partitions_vacuumed',             ARRAY[]::text[]
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'pipeline_runs_deleted',           v_pipeline_runs_deleted,
    'debug_logs_deleted',              v_debug_logs_deleted,
    'stale_cache_deleted',             v_stale_cache_deleted,
    'phantom_attempts_deleted',        v_phantom_deleted,
    'serial_failures_deleted',         v_serial_failures_deleted,
    'special_serial_failures_deleted', v_special_serial_failures_deleted,
    'unmapped_failures_deleted',       v_unmapped_failures_deleted,
    'smoke_results_deleted',           v_smoke_results_deleted,
    'usage_events_deleted',            v_usage_events_deleted,
    'snapshots_deleted',               v_snapshots_deleted,
    'support_conversations_deleted',   v_support_conversations_deleted,
    'fcl_auth_nonces_deleted',         v_nonces_deleted,
    'partitions_vacuumed',             ARRAY[]::text[],
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer
  );
END;
$function$;


INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'pack-pull-source-rip-id-backfill',
  60,
  'info',
  'Backfill cron for moment_acquisitions.source_pack_rip_id. 30min cadence (cron-job.org at :11 and :41). Caps at 1000 rows/run via backfill_pack_pull_source_rip_id(p_limit). Drains the 6925-row gap (2026-05-17) in ~3.5h. Silence past 60min implies the route or the cron entry stopped; not the RPC itself.',
  true
)
ON CONFLICT (pipeline) DO UPDATE
  SET max_silent_minutes = EXCLUDED.max_silent_minutes,
      severity = EXCLUDED.severity,
      notes = EXCLUDED.notes,
      is_active = EXCLUDED.is_active;
