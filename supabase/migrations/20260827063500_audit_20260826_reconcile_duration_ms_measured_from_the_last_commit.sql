-- audit_20260826_reconcile_duration_ms_measured_from_the_last_commit
--
-- reconcile-saved-wallet-stats recorded a duration_ms of 2-37 ms for runs that
-- actually took 6-115 SECONDS. Measured 2026-08-26 (24 h, 22 ticks):
--
--   avg extra->>'elapsed_ms'  27,370 ms      avg duration_ms   10 ms
--   max extra->>'elapsed_ms' 114,748 ms      max duration_ms   37 ms
--                                            understated by 2,688x
--
-- CAUSE: the 3-arg log_pipeline_run(text, boolean, jsonb) convenience overload hard-codes
-- `p_started_at := now()`. now() is TRANSACTION start. This is the ONLY caller in the
-- database that COMMITs (3 sites; prokind 'p'), so its final transaction begins
-- milliseconds before it logs. duration_ms is GENERATED from (finished_at - started_at),
-- so it faithfully recorded a window that had nothing to do with the run.
--
-- SCOPE, enumerated rather than assumed: 15 objects call log_pipeline_run. 14 are
-- non-COMMITting FUNCTIONS, where now() IS the true start, so they are correct and are
-- NOT touched. This procedure is the only one affected -- which is exactly why the bug
-- survived: the shared helper is right for every caller but one.
--
-- ⭐ It was findable only because this procedure ALSO self-reports elapsed_ms in extra.
-- A caller using the same overload without that field would be wrong and undetectable.
--
-- EQUIVALENCE: the body below is the pinned snapshot
-- (20260816181600_audit_20260816_snapshot_reconcile_all_saved_wallet_stats.sql, which
-- db:pins:check reports clean against live) with ONLY the log call's argument form
-- changed. Every logged value is identical -- see the inline comment at the call site.
--
-- REVERT: re-apply the pinned snapshot migration verbatim. It restores the 3-arg call
-- and with it the wrong duration_ms; nothing else differs.

CREATE OR REPLACE PROCEDURE public.reconcile_all_saved_wallet_stats(IN p_max_seconds integer DEFAULT 50, IN p_max_wallets integer DEFAULT 500, IN p_min_age_minutes integer DEFAULT 360)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_deadline   timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_max_seconds, 1));
  v_pairs      jsonb;
  v_total      integer := 0;
  v_wallets    integer := 0;
  v_refreshed  integer := 0;
  v_zeroed     integer := 0;
  v_truncated  boolean := false;
  v_oldest_h   numeric;
  i            integer;
BEGIN
  UPDATE public.saved_wallets sw
     SET cached_moment_count = 0,
         cached_fmv_usd      = NULL,
         cached_top_tier     = NULL,
         cache_updated_at    = NOW()
   WHERE sw.wallet_addr IS NOT NULL
     AND (sw.cached_moment_count IS DISTINCT FROM 0
          OR sw.cached_fmv_usd IS NOT NULL
          OR sw.cached_top_tier IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1
         FROM public.wallet_moments_cache w
        WHERE w.wallet_address = sw.wallet_addr
          AND w.collection_id  = sw.collection_id
     );
  GET DIAGNOSTICS v_zeroed = ROW_COUNT;
  COMMIT;

  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('u', s.user_id, 'w', s.wallet_addr)
                     ORDER BY s.stalest ASC NULLS FIRST),
           '[]'::jsonb)
    INTO v_pairs
    FROM (
      SELECT sw.user_id, sw.wallet_addr, MIN(sw.cache_updated_at) AS stalest
        FROM public.saved_wallets sw
       WHERE sw.wallet_addr IS NOT NULL
         AND sw.user_id IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.wallet_moments_cache w
            WHERE w.wallet_address = sw.wallet_addr
              AND w.collection_id  = sw.collection_id
         )
       GROUP BY sw.user_id, sw.wallet_addr
      HAVING MIN(sw.cache_updated_at) IS NULL
          OR MIN(sw.cache_updated_at) < now() - make_interval(mins => GREATEST(p_min_age_minutes, 0))
    ) s;

  v_total := jsonb_array_length(v_pairs);

  FOR i IN 0 .. v_total - 1 LOOP
    IF clock_timestamp() >= v_deadline OR v_wallets >= p_max_wallets THEN
      v_truncated := true;
      EXIT;
    END IF;

    v_refreshed := v_refreshed + COALESCE(
      public.aggregate_saved_wallet_stats(
        (v_pairs -> i ->> 'u')::uuid,
        (v_pairs -> i ->> 'w')
      ), 0);
    v_wallets := v_wallets + 1;

    COMMIT;
  END LOOP;

  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.saved_wallets
   WHERE wallet_addr IS NOT NULL;

  -- ⚠ The 3-arg log_pipeline_run(text, boolean, jsonb) overload passes
  -- `p_started_at := now()`. now() is TRANSACTION START, and this procedure COMMITs
  -- per wallet, so by the time it logs, now() is the start of the tiny post-COMMIT
  -- transaction -- NOT the start of the sweep. duration_ms is a GENERATED column
  -- (finished_at - started_at), so it recorded the few ms since the last COMMIT.
  -- Measured 2026-08-26: avg elapsed 27,370 ms recorded as 10 ms, worst 114,748 ms
  -- recorded as 37 ms -- understated 2,688x. The named-arg form below passes the
  -- real v_started (clock_timestamp() at procedure entry).
  -- ⚠ Every other value is IDENTICAL to what the 3-arg overload derived, so nothing
  -- that reads pipeline_runs or extra changes: it mapped p_rows_found from
  -- extra->>'fetched' (= v_total), p_rows_written from extra->>'upserted'
  -- (= v_refreshed), p_rows_skipped from a key this caller never set (= 0), and
  -- p_error from extra->>'error'. The extra jsonb below is byte-identical.
  -- ⛔ Do NOT "fix" this in the 3-arg overload itself -- 14 other callers use it and
  -- they are all non-COMMITting FUNCTIONS, where now() IS their true start.
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'reconcile-saved-wallet-stats',
    p_started_at   := v_started,
    p_rows_found   := v_total,
    p_rows_written := v_refreshed,
    p_rows_skipped := 0,
    p_ok           := NOT v_truncated,
    p_error        := CASE WHEN v_truncated
                           THEN 'soft_deadline_reached_partial_sweep_committed'
                           ELSE NULL END,
    p_extra        := jsonb_build_object(
      'wallets_done',      v_wallets,
      'wallets_total',     v_total,
      'fetched',           v_total,
      'truncated',         v_truncated,
      'upserted',          v_refreshed,
      'rows_zeroed',       v_zeroed,
      'oldest_cache_h',    v_oldest_h,
      'min_age_minutes',   p_min_age_minutes,
      'elapsed_ms',        ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000),
      'error',             CASE WHEN v_truncated
                                THEN 'soft_deadline_reached_partial_sweep_committed'
                                ELSE NULL END
    )
  );
  COMMIT;
END;
$procedure$;
