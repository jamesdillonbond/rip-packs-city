-- audit_20260901_reconcile_all_seeded_wallet_stats_no_txn_control
--
-- MEASURED FAILURE THIS PASS, and the reason is worth more than the fix.
--
-- The first version of this procedure copied reconcile_all_saved_wallet_stats and
-- COMMITted per wallet. Scheduled as pg_cron jobid 430 with the repo's standard
-- long-job command form:
--       SET statement_timeout = '900s'; CALL public.reconcile_all_seeded_wallet_stats(420, 4, 1200);
-- it ran 11:18:00.21Z -> 11:19:51.48Z (111 s, the first whale) and then died with
--       ERROR: invalid transaction termination
--       CONTEXT: PL/pgSQL function reconcile_all_seeded_wallet_stats(...) line 49 at COMMIT
--
-- ⭐ WHY, and this generalises: pg_cron sends the job command as ONE simple-query
--    message. Two statements in one simple-query message form an IMPLICIT
--    TRANSACTION BLOCK, and a procedure cannot COMMIT inside one. So the
--    `SET ...; CALL ...` idiom and procedure-level transaction control are MUTUALLY
--    EXCLUSIVE in a pg_cron command.
--
-- ⛔ THIS CORRECTS AN ACTIONABLE READING OF docs/overnight/inbox/2026-08-31T1425Z-
--    five-postgres-cron-jobs-are-clipped-at-the-db-default-120s-because-their-
--    command-lacks-the-SET-prefix.md. At least one of those jobs -- jobid 259
--    `rpc-reconcile-saved-wallet-stats`, `CALL public.reconcile_all_saved_wallet_stats(10, 40, 360);`
--    -- COMMITs per wallet. Adding the SET prefix to it would BREAK it with this
--    exact error, not raise its ceiling. Its 10-second p_max_seconds means the
--    120 s default was never binding for it anyway. Check for COMMIT in the callee
--    before "fixing" any of those five.
--
-- Measured constants behind the choice made here (all read this pass):
--   * postgresql.conf statement_timeout = 120000 (120 s); role `postgres` has NO
--     rolconfig override (only search_path), so a bare `CALL` from pg_cron as
--     postgres is clipped at 120 s.
--   * The largest active seeded wallet needs ~111 s for one refresh in the QUIETEST
--     band of the day. 120 s is not a usable ceiling for it.
--   => Transaction control is dropped and the SET prefix is kept. The sweep is now
--      ONE transaction. This matches ~12 existing jobs (235/236/237/240/241/4/5/36/
--      49/50/54/199) that already run 180-600 s single-transaction under this idiom.
--
-- WHAT IS LOST, stated plainly: partial durability. If the whole CALL dies, no
-- wallet is written. That is acceptable at this size -- the queue is bounded to
-- p_max_wallets (4) and p_max_seconds (300), the per-wallet EXCEPTION handler
-- already stops one bad wallet from killing the sweep, and the work is a display
-- cache that the next tick recomputes anyway.
-- ⚠ Second consequence: now() is frozen at transaction start, so
-- `last_refreshed_at` understates freshness by up to the sweep's own duration.
-- Immaterial against a 1,200-minute age gate.
--
-- REVERT (both halves):
--   SELECT cron.unschedule('rpc-reconcile-seeded-wallet-stats');
--   DROP PROCEDURE IF EXISTS public.reconcile_all_seeded_wallet_stats(integer, integer, integer);

CREATE OR REPLACE PROCEDURE public.reconcile_all_seeded_wallet_stats(
  p_max_seconds     integer DEFAULT 300,
  p_max_wallets     integer DEFAULT 4,
  p_min_age_minutes integer DEFAULT 1200
)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $proc$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_deadline   timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_max_seconds, 1));
  v_wallets    text[];
  v_total      integer := 0;
  v_done       integer := 0;
  v_ok         integer := 0;
  v_failed     integer := 0;
  v_truncated  boolean := false;
  v_last_error text := NULL;
  v_oldest_h   numeric;
  i            integer;
BEGIN
  -- Queue: ACTIVE seeded wallets with a real address whose cache is older than the
  -- age gate, stalest first.
  --
  -- is_active = false is EXCLUDED DELIBERATELY. Measured 2026-09-01 11:0xZ: 15 of
  -- the 17 addressed rows stale > 7 days are is_active = false -- 11 tagged
  -- bot_suspected / exclude_from_user_analytics, 4 dormant legacy seeds at 3,322 h
  -- with zero wmc rows -- plus 6 more is_active = false rows with wallet_address
  -- IS NULL (an address-keyed function cannot refresh those at all). Their
  -- staleness is BY DESIGN. Any future reader who "fixes" it is adding cost for
  -- rows nothing displays.
  --
  -- The real residue is 2 rows: ACTIVE seeded wallets stale > 48 h = exactly
  -- 0x0d744d23165bfb6c (155,411 wmc rows, 601.3 h) and 0xee4fe6c87ab048d0
  -- (67,445 rows, 489.6 h). The 24-48 h band (47 more) is normal low-priority
  -- churn that the client path does clear -- which is why the age gate defaults to
  -- 1,200 minutes with p_max_wallets = 4 rather than sweeping all 49.
  SELECT COALESCE(array_agg(s.wallet_address ORDER BY s.last_refreshed_at ASC NULLS FIRST), '{}'::text[])
    INTO v_wallets
    FROM public.seeded_wallets s
   WHERE s.wallet_address IS NOT NULL
     AND s.is_active IS TRUE
     AND (s.last_refreshed_at IS NULL
          OR s.last_refreshed_at < now() - make_interval(mins => GREATEST(p_min_age_minutes, 0)));

  v_total := COALESCE(array_length(v_wallets, 1), 0);

  FOR i IN 1 .. v_total LOOP
    IF clock_timestamp() >= v_deadline OR v_done >= p_max_wallets THEN
      v_truncated := true;
      EXIT;
    END IF;

    -- Per-wallet subtransaction: one wallet erroring must not throw away the rest
    -- of the sweep. ⛔ Do NOT add COMMIT here -- see the header.
    BEGIN
      PERFORM public.refresh_seeded_wallet_stats(v_wallets[i]);
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last_error := left(SQLERRM, 200);
    END;

    v_done := v_done + 1;
  END LOOP;

  -- Freshness metric over the SAME population the queue reads, so it can actually
  -- move in response to this sweep. (The saved_wallets sibling carries a long note
  -- about what goes wrong when those two predicates diverge -- 2026-08-28.)
  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(s.last_refreshed_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.seeded_wallets s
   WHERE s.wallet_address IS NOT NULL
     AND s.is_active IS TRUE;

  PERFORM public.log_pipeline_run(
    p_pipeline     := 'reconcile-seeded-wallet-stats',
    p_started_at   := v_started,
    p_rows_found   := v_total,
    p_rows_written := v_ok,
    p_rows_skipped := GREATEST(v_total - v_done, 0),
    p_ok           := (v_failed = 0),
    p_error        := CASE WHEN v_failed > 0 THEN v_last_error ELSE NULL END,
    p_extra        := jsonb_build_object(
      'wallets_queued',   v_total,
      'wallets_done',     v_done,
      'wallets_ok',       v_ok,
      'wallets_failed',   v_failed,
      'truncated',        v_truncated,
      'oldest_active_h',  v_oldest_h,
      'min_age_minutes',  p_min_age_minutes,
      'max_seconds',      p_max_seconds,
      'max_wallets',      p_max_wallets,
      'elapsed_ms',       ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000),
      'last_error',       v_last_error
    )
  );
END;
$proc$;

COMMENT ON PROCEDURE public.reconcile_all_seeded_wallet_stats(integer, integer, integer) IS
  'Server-side reconciler for the seeded_wallets display cache. Runs as postgres under pg_cron with a SET statement_timeout prefix to escape BOTH the 30s service_role ceiling (which makes the two largest ACTIVE seeded wallets structurally unrefreshable via the client path) and the 120s postgresql.conf default. NO transaction control: a pg_cron SET-prefixed command is an implicit transaction block and COMMIT raises invalid transaction termination there. Writes a reconcile-seeded-wallet-stats pipeline_runs row -- the only instrument that can see this class of failure. Revert: cron.unschedule(''rpc-reconcile-seeded-wallet-stats'') + DROP PROCEDURE.';