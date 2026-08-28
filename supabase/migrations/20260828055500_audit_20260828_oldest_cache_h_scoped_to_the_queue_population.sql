-- audit_20260828_oldest_cache_h_scoped_to_the_queue_population
--
-- reconcile_all_saved_wallet_stats: make extra.oldest_cache_h measure the
-- population the sweep can actually act on.
--
-- Applies the fix specified in §5 of
-- docs/overnight/inbox/2026-08-22T0130Z-oldest-cache-h-measures-a-population-the-sweep-excludes-by-construction.md
-- which was correct and cheap on 2026-08-21 and was deferred TWICE, both times on
-- migration COST rather than on doubt about the fix. Applied now in a genuinely
-- quiet window (1 active backend, 0 IO waiters), which is the condition both
-- deferrals named.
--
-- ⚠ EVERYTHING ELSE IN THIS PROCEDURE IS BYTE-IDENTICAL to
-- 20260827063500_audit_20260826_reconcile_duration_ms_measured_from_the_last_commit.sql,
-- extracted programmatically rather than retyped. In particular the procedure
-- COMMITs per wallet and carries NO SET clause -- a SET clause on a COMMITting
-- procedure silently stops it committing, which this repo has shipped twice.
--
-- ── anon-execute decision (guard: __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- anon-exec: unchanged (reconcile_all_saved_wallet_stats) -- a CREATE OR REPLACE of an
-- EXISTING procedure, and CREATE OR REPLACE does not reset an ACL, so a REVOKE here
-- would be a production ACL change dressed up as a no-op. The marker is the correct form.
--
-- Revert: re-apply
-- 20260827063500_audit_20260826_reconcile_duration_ms_measured_from_the_last_commit.sql.

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

  -- ⚠ SCOPED TO THE QUEUE'S OWN POPULATION (2026-08-28). This used to read every
  -- saved_wallets row, while the queue below reads only rows that HAVE wmc rows.
  -- MIN(cache_updated_at) was therefore pinned forever by 21 rows the sweep
  -- CANNOT touch by design -- the 2026-08-09 explicit zero-pass, all with
  -- cached_moment_count = 0 and zero wmc rows, deliberately excluded by the
  -- EXISTS clause. The figure rose +1.0/hour indefinitely and could never fall:
  -- 308 h on 08-21, 442.9 h on 08-27, +1.00/hour to two decimals.
  --
  -- ⚠ THE CONSEQUENCE THAT MATTERS IS THE INVERSE ONE: a genuine starvation --
  -- a QUEUED wallet going unreconciled for days -- was INVISIBLE, because the
  -- number was already pinned and climbing from an unrelated cause. It could not
  -- move in response to the thing it is named for. It also misled two separate
  -- readers into near-filing a user-facing alarm.
  --
  -- Measured with this predicate on 2026-08-27: oldest ELIGIBLE staleness 15.1 h
  -- (avg 10.0 h, zero over 7 days) against a reported 442.9 h -- so the metric
  -- overstated by ~29x and the sweep is very nearly keeping up. Both halves
  -- matter: "the metric is broken" and "the sweep is behind" need opposite
  -- responses.
  --
  -- The EXISTS is copied VERBATIM from v_pairs, including its position relative
  -- to the aggregate. Re-deriving it as bool_or() at the wallet level instead of
  -- EXISTS at the row level mixes the frozen rows back in and inverts the answer
  -- -- that is a different population, and the difference is invisible in the
  -- output because both produce a tidy per-wallet age.
  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(sw.cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.saved_wallets sw
   WHERE sw.wallet_addr IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.wallet_moments_cache w
        WHERE w.wallet_address = sw.wallet_addr
          AND w.collection_id  = sw.collection_id
     );

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
