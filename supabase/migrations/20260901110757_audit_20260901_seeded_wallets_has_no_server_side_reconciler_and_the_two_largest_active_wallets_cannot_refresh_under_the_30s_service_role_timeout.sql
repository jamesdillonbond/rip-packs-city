-- audit_20260901_reconcile_all_seeded_wallet_stats
--
-- WHY (measured 2026-09-01 11:0xZ = 04:0x PT, the quietest band of the day):
--   public.seeded_wallets has NO server-side reconciler. Its ONLY refresh path is
--   stampLastRefreshed() in lib/chains/flow/wallet-backfill-helpers.ts, which calls
--   public.refresh_seeded_wallet_stats(wallet) over PostgREST as service_role --
--   and service_role carries rolconfig statement_timeout=30s.
--
--   refresh_seeded_wallet_stats wraps holdings_summary(), a cross-collection
--   aggregate. Measured COLD, this pass, in the quiet band, on the SECOND-largest
--   active seeded wallet (0xee4fe6c87ab048d0, 67,445 wmc rows):
--       EXPLAIN (ANALYZE, BUFFERS) SELECT public.holdings_summary('0xee4fe6c87ab048d0')
--       -> 13,242 ms, shared hit=37941 read=46870, temp read=1347 written=1349
--   The LARGEST active seeded wallet (0x0d744d23165bfb6c) holds 155,411 wmc rows,
--   2.30x that. Both therefore exceed the 30 s ceiling deterministically -- and the
--   0859Z pass measured this same workload running ~48x slower in the 19:30-01:00Z
--   saturation band at identical buffer counts.
--
--   Consequence, read from seeded_wallets at 11:0xZ: those two wallets are the ONLY
--   active seeded wallets stale beyond 7 days -- 601.3 h and 489.6 h respectively.
--   (The other 15 rows stale >7 d are all is_active = false: 11 tagged
--   bot_suspected/exclude_from_user_analytics and 4 dormant legacy seeds, plus 6
--   is_active=false rows with wallet_address IS NULL. Their staleness is BY DESIGN
--   and must not be chased.) 49 of 253 ACTIVE wallets are stale > 24 h.
--
--   The caller swallows the failure (`catch { /* swallow */ }`) and the function
--   writes no pipeline_runs row, so detect_stalled_pipelines() and
--   get_pipeline_alerts() are blind to it by construction. Sentry has been dark
--   since the 08-18 quota exhaustion. A cost ranking cannot see a failure either.
--
-- WHAT THIS DOES:
--   Adds the sibling of the PROVEN public.reconcile_all_saved_wallet_stats
--   (pg_cron jobid 259, hourly, shipped for saved_wallets) for seeded_wallets:
--   deadline-bounded, COMMITs per wallet, catches per-wallet failures instead of
--   losing the sweep, and writes a `reconcile-seeded-wallet-stats` pipeline_runs
--   row -- which is the instrument this defect has been invisible to twice in 12 h.
--   Running under pg_cron as `postgres` escapes the 30 s service_role ceiling.
--
--   It does NOT modify refresh_seeded_wallet_stats or holdings_summary, and it
--   selects only rows the client path is already failing to keep fresh
--   (is_active, address non-null, older than p_min_age_minutes), stalest first --
--   so it does not duplicate work the normal path is doing.
--
-- REVERT (both halves):
--   SELECT cron.unschedule('rpc-reconcile-seeded-wallet-stats');
--   DROP PROCEDURE IF EXISTS public.reconcile_all_seeded_wallet_stats(integer, integer, integer);
--   (No data change to undo: the procedure only writes seeded_wallets cache columns
--    that refresh_seeded_wallet_stats already owns, plus one pipeline_runs row.)
--
-- EXIT CONDITION (derived from the post-fix measurement, not a hoped-for order of
--   magnitude): after the first tick, `SELECT max(age) FROM (…)` over ACTIVE
--   seeded_wallets must show 0 active wallets stale > 7 days, and the
--   `reconcile-seeded-wallet-stats` pipeline_runs row must report
--   wallets_failed = 0 with wallets_done >= 2.
-- FALSIFIER: if the two whales still fail inside a 600 s statement_timeout as
--   postgres, the ceiling was never the binding constraint and this must be
--   reverted in favour of making holdings_summary cheaper.

DO $mig$
BEGIN
  -- Pre-flight: the exact callee must exist with the exact signature.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_seeded_wallet_stats'
      AND pg_get_function_identity_arguments(p.oid) = 'p_wallet_address text'
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: public.refresh_seeded_wallet_stats(p_wallet_address text) not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'log_pipeline_run'
      AND pg_get_function_identity_arguments(p.oid) LIKE 'p_pipeline text, p_started_at timestamp with time zone%'
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: the 11-arg public.log_pipeline_run overload not found';
  END IF;
END
$mig$;

CREATE OR REPLACE PROCEDURE public.reconcile_all_seeded_wallet_stats(
  p_max_seconds     integer DEFAULT 240,
  p_max_wallets     integer DEFAULT 8,
  p_min_age_minutes integer DEFAULT 1440
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
  -- age gate. is_active = false rows are EXCLUDED deliberately -- 15 of them are
  -- stale > 7 d by design (bot_suspected / exclude_from_user_analytics / dormant
  -- legacy seeds) and refreshing them would be pure cost. NULL addresses cannot be
  -- refreshed by an address-keyed function at all (6 rows, all is_active = false).
  -- Stalest first, so the two structurally-unrefreshable whales are always covered.
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

    -- Per-wallet subtransaction: one wallet timing out or erroring must not throw
    -- away the wallets already reconciled in this sweep. COMMIT sits OUTSIDE this
    -- block -- plpgsql forbids ending a transaction inside an exception handler.
    BEGIN
      PERFORM public.refresh_seeded_wallet_stats(v_wallets[i]);
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last_error := left(SQLERRM, 200);
    END;

    v_done := v_done + 1;
    COMMIT;
  END LOOP;

  -- Freshness metric over the SAME population the queue reads, so it can actually
  -- move in response to this sweep. (The saved_wallets sibling carries a long note
  -- about what goes wrong when these two predicates diverge -- 2026-08-28.)
  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(s.last_refreshed_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.seeded_wallets s
   WHERE s.wallet_address IS NOT NULL
     AND s.is_active IS TRUE;

  -- Named-arg (11-arg) overload: the 3-arg one passes p_started_at := now(), which
  -- is TRANSACTION start -- meaningless in a procedure that COMMITs per wallet.
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
  COMMIT;
END;
$proc$;

-- A new PROCEDURE lands with the default EXECUTE TO PUBLIC. It drives an expensive
-- cross-collection aggregate, so close that immediately (checklist item 5/6).
REVOKE EXECUTE ON PROCEDURE public.reconcile_all_seeded_wallet_stats(integer, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON PROCEDURE public.reconcile_all_seeded_wallet_stats(integer, integer, integer) FROM anon;
REVOKE EXECUTE ON PROCEDURE public.reconcile_all_seeded_wallet_stats(integer, integer, integer) FROM authenticated;
GRANT  EXECUTE ON PROCEDURE public.reconcile_all_seeded_wallet_stats(integer, integer, integer) TO postgres;

COMMENT ON PROCEDURE public.reconcile_all_seeded_wallet_stats(integer, integer, integer) IS
  'Server-side reconciler for seeded_wallets display cache. Sibling of reconcile_all_saved_wallet_stats. Runs as postgres under pg_cron to escape the 30s service_role statement_timeout that makes the two largest ACTIVE seeded wallets (155,411 and 67,445 wmc rows) structurally unrefreshable via the client path. Writes a reconcile-seeded-wallet-stats pipeline_runs row -- that row is the ONLY instrument that can see this class of failure. Revert: cron.unschedule(''rpc-reconcile-seeded-wallet-stats'') + DROP PROCEDURE.';