-- audit_20260913_the_saved_wallet_sweep_stops_dying_on_one_whale_and_says_whom_it_skipped
--
-- ── THE DEFECT, MEASURED ─────────────────────────────────────────────────────
-- `rpc-reconcile-saved-wallet-stats` (pg_cron 259, `44 * * * *`, runs as
-- postgres under the global 120 s statement_timeout) refreshes the cached
-- portfolio figures every collector sees against their own saved wallets. It
-- walks the queue stalest-first and COMMITs per wallet. From 07:44 PT today it
-- failed EVERY hour — 7:44, 8:44, 9:44, 10:44 (`canceling statement due to
-- statement timeout` inside aggregate_saved_wallet_stats' `WITH agg AS`), 11:44
-- (worker-slot startup timeout), 12:44 and 13:44 — the last two on a CALM
-- instance (3–4 IO waiters, 4 failed of 182 cron runs in 30 min). Portfolio
-- Cache Drain read 13 h and climbing.
--
-- The head of the queue is one wallet: 0xf77bf547… with 39,948 Top Shot
-- moments + 4,580 All Day + 118 more (cached 09-12 22:44 PT, stale since 04:44).
-- Its aggregate — 44.6k wallet_moments_cache rows joined to editions and
-- edition_fmv_current, with `tier` fetched from the heap for every row — does
-- not finish inside 120 s even on the merge-join plan (an EXPLAIN ANALYZE of the
-- SELECT alone outran a 60 s client). Stalest-first puts it FIRST every hour, so
-- the CALL dies on it before any other wallet is touched: a head-of-line block,
-- the same shape as the counterparty lane's 42-row residue (ledger, 09-13), and
-- 91 other saved wallets went unrefreshed for seven hours because of one.
--
-- ⚠ A per-wallet timeout inside the CALL is not available: statement_timeout is
-- the TOP-LEVEL statement's clock, started when the CALL began, and `EXCEPTION
-- WHEN OTHERS` does not catch the cancel (database.md). The covering index that
-- would make the whale's aggregate index-only (INCLUDE fmv_usd, tier) is a
-- multi-minute CONCURRENTLY build on a 2.4M-row table — a quiet-window job,
-- filed, not this migration.
--
-- ── THE CHANGE ───────────────────────────────────────────────────────────────
-- A fourth parameter, `p_max_moments` (default 20,000). A (user, wallet) pair
-- whose cached_moment_count sums above it is NOT attempted by the hourly sweep;
-- it is COUNTED, logged (`wallets_skipped_big`, `p_rows_skipped`, and its own
-- staleness `oldest_big_cache_h`) and excluded from `oldest_cache_h`, which
-- otherwise would pin to the skipped wallet and hide a genuine starvation — the
-- exact metric trap the 08-28 fix in this same procedure records. Everything
-- else is byte-identical: order, gate, zero pass, per-wallet COMMITs, the log.
--
-- What the skipped collector sees: the same figures they saw before, with the
-- cache age their dashboard already renders — a stale number labelled stale, not
-- a fresh-looking wrong one. What everyone else gets back: an hourly refresh.
--
-- The three-argument signature is DROPPED first: CREATE OR REPLACE with a new
-- parameter would ADD an overload, and pg_cron's `CALL …(45, 40, 360)` would
-- then be ambiguous against both. The cron command is unchanged; the fourth
-- argument takes its default.
--
-- anon-exec: reconcile_all_saved_wallet_stats -- unchanged (not SECURITY DEFINER; the pg_cron caller is postgres; PUBLIC/anon/authenticated EXECUTE revoked below as it was)

DROP PROCEDURE IF EXISTS public.reconcile_all_saved_wallet_stats(integer, integer, integer);

CREATE OR REPLACE PROCEDURE public.reconcile_all_saved_wallet_stats(IN p_max_seconds integer DEFAULT 50, IN p_max_wallets integer DEFAULT 500, IN p_min_age_minutes integer DEFAULT 360, IN p_max_moments integer DEFAULT 20000)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_started      timestamptz := clock_timestamp();
  v_deadline     timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_max_seconds, 1));
  v_pairs        jsonb;
  v_total        integer := 0;
  v_wallets      integer := 0;
  v_refreshed    integer := 0;
  v_zeroed       integer := 0;
  v_skipped_big  integer := 0;
  v_truncated    boolean := false;
  v_oldest_h     numeric;
  v_oldest_big_h numeric;
  i              integer;
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

  -- ⚠ WALLETS ABOVE p_max_moments ARE NOT IN THIS QUEUE (2026-09-13). One wallet
  -- with 44.6k moments cannot be aggregated inside the CALL's 120 s budget, and
  -- stalest-first put it at the head every hour, so the CALL died there before
  -- touching anyone else. They are counted below and logged, never silently
  -- dropped. A never-refreshed wallet (count NULL -> 0) is still attempted once.
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
      HAVING (MIN(sw.cache_updated_at) IS NULL
              OR MIN(sw.cache_updated_at) < now() - make_interval(mins => GREATEST(p_min_age_minutes, 0)))
         AND COALESCE(SUM(sw.cached_moment_count), 0) <= GREATEST(p_max_moments, 0)
    ) s;

  -- The wallets the gate above kept OUT, so the run can say so. Same population
  -- and staleness test as the queue, with the size test inverted.
  SELECT count(*)
    INTO v_skipped_big
    FROM (
      SELECT sw.user_id, sw.wallet_addr
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
      HAVING (MIN(sw.cache_updated_at) IS NULL
              OR MIN(sw.cache_updated_at) < now() - make_interval(mins => GREATEST(p_min_age_minutes, 0)))
         AND COALESCE(SUM(sw.cached_moment_count), 0) > GREATEST(p_max_moments, 0)
    ) b;

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
  --
  -- ⚠ AND SINCE 2026-09-13 IT EXCLUDES THE ROWS THE SIZE GATE SKIPS, for the same
  -- reason: a wallet the sweep will never attempt would pin this figure forever
  -- and hide a starving QUEUED wallet behind it. The skipped population gets its
  -- own figure below (oldest_big_cache_h). Per-row count here against a per-pair
  -- SUM in the queue: a pair can only exceed the gate if some row is large, and a
  -- row above the gate is never attempted, so the two populations agree except
  -- for a pair of mid-sized rows summing past it, which reads as eligible here
  -- and skipped there -- a bounded, stated approximation.
  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(sw.cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.saved_wallets sw
   WHERE sw.wallet_addr IS NOT NULL
     AND COALESCE(sw.cached_moment_count, 0) <= GREATEST(p_max_moments, 0)
     AND EXISTS (
       SELECT 1
         FROM public.wallet_moments_cache w
        WHERE w.wallet_address = sw.wallet_addr
          AND w.collection_id  = sw.collection_id
     );

  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(sw.cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_big_h
    FROM public.saved_wallets sw
   WHERE sw.wallet_addr IS NOT NULL
     AND COALESCE(sw.cached_moment_count, 0) > GREATEST(p_max_moments, 0)
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
  -- ⚠ p_rows_skipped is REAL since 2026-09-13 (the size-gated wallets); before
  -- that it was a key this caller never set (= 0). Every other value is what the
  -- 3-arg overload derived: p_rows_found from extra->>'fetched' (= v_total),
  -- p_rows_written from extra->>'upserted' (= v_refreshed), p_error from
  -- extra->>'error'. The extra jsonb gains three keys and changes no existing one.
  -- ⛔ Do NOT "fix" this in the 3-arg overload itself -- 14 other callers use it and
  -- they are all non-COMMITting FUNCTIONS, where now() IS their true start.
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'reconcile-saved-wallet-stats',
    p_started_at   := v_started,
    p_rows_found   := v_total,
    p_rows_written := v_refreshed,
    p_rows_skipped := v_skipped_big,
    p_ok           := NOT v_truncated,
    p_error        := CASE WHEN v_truncated
                           THEN 'soft_deadline_reached_partial_sweep_committed'
                           ELSE NULL END,
    p_extra        := jsonb_build_object(
      'wallets_done',        v_wallets,
      'wallets_total',       v_total,
      'wallets_skipped_big', v_skipped_big,
      'max_moments',         p_max_moments,
      'fetched',             v_total,
      'truncated',           v_truncated,
      'upserted',            v_refreshed,
      'rows_zeroed',         v_zeroed,
      'oldest_cache_h',      v_oldest_h,
      'oldest_big_cache_h',  v_oldest_big_h,
      'min_age_minutes',     p_min_age_minutes,
      'elapsed_ms',          ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000),
      'error',               CASE WHEN v_truncated
                                  THEN 'soft_deadline_reached_partial_sweep_committed'
                                  ELSE NULL END
    )
  );
  COMMIT;
END;
$procedure$;

REVOKE EXECUTE ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer, integer, integer) TO postgres, service_role;

COMMENT ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer, integer, integer) IS
  'Hourly sweep (pg_cron rpc-reconcile-saved-wallet-stats, 44 * * * *) refreshing the cached portfolio figures on saved_wallets, stalest-first with a per-wallet COMMIT and a soft deadline. Since 2026-09-13 a (user, wallet) pair whose cached_moment_count sums above p_max_moments (default 20,000) is skipped, counted in extra.wallets_skipped_big / p_rows_skipped and measured in extra.oldest_big_cache_h, because one 44.6k-moment wallet at the head of the queue killed the CALL at the 120 s statement budget every hour and starved the other 91. Pinned by supabase/tests/reconcile_all_saved_wallet_stats.sql.';
