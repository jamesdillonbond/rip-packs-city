-- audit_20260810_reconcile_saved_wallet_stats_resumable_procedure
--
-- WHY -------------------------------------------------------------------------
-- `rpc-reconcile-saved-wallet-stats` (pg_cron jobid 259) is the convergence
-- backstop for the three denormalised display columns on `saved_wallets`
-- (`cached_moment_count` / `cached_fmv_usd` / `cached_top_tier`), which render on
-- /dashboard, /profile/<username>, the collection profile page, /share and the
-- profile OG card. Its only other writer -- the opportunistic re-stamp at the end
-- of `wallet-backfill-multicollection` -- is best-effort by design and only fires
-- for wallets the orchestrator happens to walk, so wallets it never walks are
-- exactly the ones only this backstop can fix.
--
-- It had never once succeeded on schedule (2 of 2 scheduled attempts killed):
--     2026-08-09 13:33Z  failed 120.0s  (global 120s cap)
--     2026-08-10 13:33Z  failed 300.4s  (after the in-command SET raised it to 300s)
-- Root cause is NOT the budget. `reconcile_all_saved_wallet_stats()` was a single
-- FUNCTION call, i.e. ONE statement, so a `statement_timeout` kill rolled back all
-- 21 wallets and the run produced nothing -- the same all-or-nothing shape recorded
-- for `rpc_trust_health_precompute_refresh`. Raising the budget a third time only
-- buys a longer worker-slot squat before the same kill (see
-- docs/overnight/inbox/2026-08-10T1430Z-reconcile-saved-wallet-stats-profile.md
-- for the cost profile: `top_tier` is the only heap-forcing leg, and folding it
-- into the aggregate measures only -21%, not the ~5x the subplan share suggests).
--
-- WHAT ------------------------------------------------------------------------
-- FUNCTION -> PROCEDURE with a per-wallet COMMIT, so a kill costs at most the
-- wallet in flight and every wallet already done stays done, plus:
--   * STALEST-FIRST ordering (min(cache_updated_at) ASC NULLS FIRST). This is what
--     makes a partial run converge: each run works the wallets that need it most,
--     so successive runs finish the set instead of re-doing the same prefix.
--   * a SOFT DEADLINE (default 100s, under the 120s role budget) so the job exits
--     cleanly and reports what it did rather than being killed mid-wallet, and
--     never squats a worker slot longer than that.
--   * honest telemetry to `pipeline_runs` as `reconcile-saved-wallet-stats`
--     (the jsonb return value is not available to a pg_cron CALL), carrying
--     `truncated` + `wallets_done`/`wallets_total` so a backstop that stops
--     converging is visible instead of silent.
--
-- MEASURED, because the obvious assumptions here are wrong ---------------------
-- (probe: a throwaway pg_cron job on this instance, 2026-08-10 15:49-15:52Z, 4 runs)
--   * COMMIT inside a procedure DOES work under pg_cron. Confirmed, 4/4 runs.
--   * `statement_timeout` does NOT re-arm per wallet. The probe set the session
--     GUC to 2500ms and then ran three 3.0s legs; all three survived, each
--     reporting `statement_timeout = 2500ms` at its own commit boundary. The timer
--     armed at top-level statement start is the only one that counts (the same
--     reason a function-level `SET statement_timeout` is inert here). So this
--     procedure gets ONE budget for the whole CALL, not one per wallet -- which is
--     precisely why the deadline + stalest-first ordering, not the COMMIT alone,
--     are what make it converge.
--   * The cron command MUST be a single statement. `SET ...; CALL ...` puts the
--     command in an implicit transaction block and the COMMIT then fails outright
--     with 2D000 `invalid transaction termination`. Hence the SET prefix that the
--     2026-08-09 change added is REMOVED here; the job runs as `postgres` and
--     takes the 120s database default. DO NOT re-add a SET prefix to this job.
--   * ⚠ A procedure that does transaction control can be NEITHER `SECURITY
--     DEFINER` NOR carry a `SET` clause. Both put the call in an atomic context and
--     COMMIT fails 2D000. Measured on this instance, three one-minute pg_cron
--     probes, 2026-08-10 15:57Z:
--         A  SECURITY DEFINER, no SET clause  -> FAILED  invalid transaction termination
--         B  invoker rights + SET search_path -> FAILED  invalid transaction termination
--         C  plain invoker, no SET clause     -> SUCCEEDED
--     So this procedure is deliberately INVOKER-rights with no `SET search_path`,
--     and therefore SCHEMA-QUALIFIES every single reference. Do not "harden" it by
--     adding either one back -- that silently reverts it to a job that dies on its
--     first tick with 2D000, which is strictly worse than the timeout it replaces.
--     Privilege is unchanged in practice and slightly reduced: pg_cron runs job 259
--     as `postgres`, the only other grantee is `service_role`, and the actual
--     column writes still go through `aggregate_saved_wallet_stats` (SECURITY
--     DEFINER) and `log_pipeline_run` (SECURITY DEFINER).
--     No runtime `SET search_path` is used either: it would persist on a pooled
--     connection after the call returns.
--
-- NOT DONE (deliberate)
--   * No budget raise (refuted twice) and no move off the 13:33Z slot -- that slot
--     is not structurally congested; the two kills were unlucky, not systematic.
--   * No `tier` covering index on `wallet_moments_cache`. It would take the
--     aggregate close to index-only, but INCLUDE columns block HOT updates exactly
--     like key columns on a 2.2M-row table that the wallet walks write constantly.
--     Not worth it for a display-only backstop.
--   * `aggregate_saved_wallet_stats(uuid, text)` is UNCHANGED -- it is still the
--     single definition of these three columns and is shared with the route.
--
-- REVERT ----------------------------------------------------------------------
--   DROP PROCEDURE IF EXISTS public.reconcile_all_saved_wallet_stats(integer, integer);
--   -- then restore the function from migration 20260809050000 and:
--   SELECT cron.alter_job(259,
--     command => $$SET statement_timeout = '300s'; SELECT public.reconcile_all_saved_wallet_stats()$$);
-- -----------------------------------------------------------------------------

-- A procedure and a function cannot share a name+signature, so the old one goes
-- first. Nothing in the app calls it (verified: only comments reference it), and
-- it carries no DB-invariant pin.
DROP FUNCTION IF EXISTS public.reconcile_all_saved_wallet_stats();

-- INVOKER rights, no SET clause -- mandatory for transaction control, see above.
-- Every reference below is schema-qualified because of it.
CREATE OR REPLACE PROCEDURE public.reconcile_all_saved_wallet_stats(
  p_max_seconds integer DEFAULT 100,
  p_max_wallets integer DEFAULT 500
)
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
  -- Snapshot the work list ordered STALEST FIRST. Materialising it up front (21
  -- pairs today; it scales with user count, not moment count) keeps the loop free
  -- of an open portal across COMMIT.
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('u', s.user_id, 'w', s.wallet_addr)
                     ORDER BY s.stalest ASC NULLS FIRST),
           '[]'::jsonb)
    INTO v_pairs
    FROM (
      SELECT user_id, wallet_addr, MIN(cache_updated_at) AS stalest
        FROM public.saved_wallets
       WHERE wallet_addr IS NOT NULL
         AND user_id IS NOT NULL
       GROUP BY user_id, wallet_addr
    ) s;

  v_total := jsonb_array_length(v_pairs);

  FOR i IN 0 .. v_total - 1 LOOP
    -- Stop cleanly rather than get killed mid-wallet. Everything committed so far
    -- stays committed, and stalest-first means the next run picks up the rest.
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

    COMMIT;  -- the point of this migration: per-wallet durability
  END LOOP;

  -- Pass 2: zero the (wallet, collection) pairs pass 1 structurally skips because
  -- the wallet holds nothing there. `aggregate_saved_wallet_stats` joins to its own
  -- GROUP BY, so a pair with zero wmc rows matches nothing and would otherwise keep
  -- its stale value forever -- a wallet that sold out of a collection would display
  -- its old count indefinitely.
  IF NOT v_truncated THEN
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
  END IF;

  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.saved_wallets
   WHERE wallet_addr IS NOT NULL;

  PERFORM public.log_pipeline_run(
    'reconcile-saved-wallet-stats',
    NOT v_truncated,
    jsonb_build_object(
      'wallets_done',      v_wallets,
      'wallets_total',     v_total,
      'fetched',           v_total,      -- -> pipeline_runs.rows_found
      'truncated',         v_truncated,
      'upserted',          v_refreshed,
      'rows_zeroed',       v_zeroed,
      'oldest_cache_h',    v_oldest_h,
      'elapsed_ms',        ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000),
      'error',             CASE WHEN v_truncated
                                THEN 'soft_deadline_reached_partial_sweep_committed'
                                ELSE NULL END
    )
  );
  COMMIT;
END;
$procedure$;

COMMENT ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer) IS
  'Convergence backstop for saved_wallets.cached_* display columns. Resumable: '
  'per-wallet COMMIT + stalest-first ordering + a soft deadline, so a statement '
  'timeout costs at most the wallet in flight and successive runs converge. '
  'statement_timeout does NOT re-arm per COMMIT (measured 2026-08-10), so the whole '
  'CALL shares one budget -- the deadline, not the COMMIT, is what bounds it. '
  'Its pg_cron command MUST stay a single statement: a "SET ...; CALL ..." prefix '
  'creates an implicit transaction block and the COMMIT fails 2D000. '
  'It is INVOKER-rights with no SET clause ON PURPOSE: a procedure that is SECURITY '
  'DEFINER or carries a SET clause cannot COMMIT at all (both measured 2026-08-10). '
  'Adding either back turns this into a job that dies on its first tick.';

-- Grants reset on the object change; restore the service-role-only posture.
-- (Supabase grants EXECUTE to anon/authenticated explicitly by default, so both a
-- PUBLIC revoke and a per-role revoke are required.)
REVOKE EXECUTE ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer) FROM anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer) TO service_role;

-- Single statement, no SET prefix -- see the 2D000 note above.
SELECT cron.alter_job(
  259,
  command => 'CALL public.reconcile_all_saved_wallet_stats();'
);
