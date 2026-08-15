-- audit_20260815_snapshot_prune_stale_wmc
--
-- SNAPSHOT MIGRATION — not a change. Captures the CURRENT live definition
-- verbatim (pg_get_functiondef, 2026-08-15) so the function becomes PINNABLE by
-- supabase/tests/prune_stale_wmc.sql + the drift guard. Applying it is a
-- byte-identical no-op.
--
-- WHY THIS FUNCTION. pg_cron `20 10 * * 0` — a WEEKLY DELETE against
-- wallet_moments_cache, the portfolio store (~2.2M rows) that ~34 DB functions
-- sum for a collector's FMV total. It was one of 25 scheduled SECDEF writers
-- with no pin.
--
-- Three invariants, all of which fail as SILENT DATA LOSS rather than an error:
--
--  1. The 14-day staleness bound. It appears TWICE — once selecting candidate
--     wallets, once inside the per-wallet DELETE — and the second one is the
--     load-bearing copy. Drop it and a wallet that qualifies on ANY stale row
--     has its ENTIRE cache deleted, including moments seen minutes ago.
--
--  2. The seeded-wallet exemption. An ACTIVE seeded wallet is never pruned, no
--     matter how stale. These are the wallets the platform's own leaderboards
--     and analytics read; pruning one empties a public surface.
--
--  3. It is per-wallet in a LOOP, not one bulk statement — which is what keeps
--     it under the destructive-op circuit breaker's >3-distinct-wallet DELETE
--     threshold on wallet_moments_cache. Rewriting it as a single set-based
--     DELETE would be blocked by rpc_guard_block_destructive at runtime, i.e.
--     the loop is a correctness requirement and not a performance style choice.

CREATE OR REPLACE FUNCTION public.prune_stale_wmc()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_stale_cache_deleted integer := 0;
  v_wallets_pruned integer := 0;
  v_wallet text;
  v_chunk integer;
BEGIN
  -- Belt-and-suspenders: robust even if invoked by a role with a tighter default
  -- (service_role 30s); cron_heavy already defaults to 600s.
  PERFORM set_config('statement_timeout', '600000', true);

  FOR v_wallet IN
    SELECT DISTINCT w.wallet_address
    FROM public.wallet_moments_cache w
    WHERE w.last_seen_at < now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM seeded_wallets sw
        WHERE sw.wallet_address = w.wallet_address
          AND sw.is_active = true
      )
  LOOP
    DELETE FROM public.wallet_moments_cache
    WHERE wallet_address = v_wallet
      AND last_seen_at < now() - interval '14 days';
    GET DIAGNOSTICS v_chunk = ROW_COUNT;
    v_stale_cache_deleted := v_stale_cache_deleted + v_chunk;
    IF v_chunk > 0 THEN
      v_wallets_pruned := v_wallets_pruned + 1;
    END IF;
  END LOOP;

  PERFORM public.log_pipeline_run(
    p_pipeline := 'weekly-wmc-prune',
    p_started_at := v_started,
    p_rows_written := v_stale_cache_deleted,
    p_extra := jsonb_build_object(
      'stale_cache_deleted', v_stale_cache_deleted,
      'wallets_pruned',      v_wallets_pruned
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'stale_cache_deleted', v_stale_cache_deleted,
    'wallets_pruned',      v_wallets_pruned,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer
  );
END;
$function$;
