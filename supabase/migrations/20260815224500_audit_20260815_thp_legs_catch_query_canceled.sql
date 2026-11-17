-- audit_20260815_thp_legs_catch_query_canceled
--
-- WHY
-- Every rpc_thp_leg_* function already carries an `EXCEPTION WHEN OTHERS THEN`
-- handler whose whole purpose is to write the 999 failure sentinel when the leg
-- cannot compute its metric. All eight are structurally incapable of firing on
-- the one failure that actually occurs on this instance.
--
-- PostgreSQL: "The special condition name OTHERS matches every error type EXCEPT
-- QUERY_CANCELED and ASSERT_FAILURE." A statement_timeout raises exactly
-- query_canceled (57014). Verified empirically on this instance 2026-08-15:
--   WHEN OTHERS                     -> did NOT catch a raised 57014 (it escaped)
--   WHEN query_canceled OR OTHERS   -> caught it
-- Corroboration: `select * from rpc_trust_health_precompute where value = 999`
-- returns ZERO rows. The sentinel has never once fired.
--
-- CONSEQUENCE (measured, not inferred)
-- A timed-out leg neither writes its value nor its sentinel, so its row keeps the
-- OLD value AND the OLD computed_at, and the error propagates out of the leg and
-- aborts rpc_trust_health_precompute_refresh_p() -- skipping every leg after it.
-- v_rpc_trust_health exposes no per-metric age, so the board then publishes a
-- stale number as if it were current. On 2026-08-15 that was
-- topshot_impossible_parallel_serials, 15.3h old (leg 8 of 8, healthy duration
-- 78.3s) while the other seven were 3.2h fresh. The 12:58Z tick died at an
-- EARLIER leg and cost every leg downstream of it.
--
-- WHY CATCHING query_canceled IS SAFE HERE
-- The docs call trapping it "possible, but often unwise" -- the concern is
-- swallowing an operator's pg_cancel_backend(). These are read-only monitoring
-- legs whose declared intent (the 999 sentinel) is already "record that I could
-- not compute this". Timer scope was measured before relying on it: the 18:58Z
-- tick ran legs of 217s and 209s to completion for a cumulative 517s, so the
-- per-statement timer is re-armed per leg rather than shared across the CALL --
-- which is what gives the handler's INSERT a working budget to write 999 with.
-- pg_terminate_backend is FATAL and remains uncatchable, as it should be.
--
-- HONEST STATUS (the half that makes this safe to ship)
-- Catching the cancel would otherwise convert a LOUD failure (pg_cron marks the
-- job failed) into a quiet per-metric 999, which for any arm that does not breach
-- at 999 is strictly worse than today. So the orchestrator now re-raises AFTER
-- all eight legs have run: the chain completes, every leg gets its attempt, and
-- cron.job_run_details still records the tick as failed.
--
-- ROLLBACK
--   Restore the previous clause on all eight legs:
--     DO $r$ DECLARE x record; d text; BEGIN
--       FOR x IN SELECT oid FROM pg_proc
--        WHERE pronamespace='public'::regnamespace AND proname LIKE 'rpc\_thp\_leg\_%'
--       LOOP d := pg_get_functiondef(x.oid);
--         EXECUTE replace(d,'EXCEPTION WHEN query_canceled OR OTHERS THEN',
--                           'EXCEPTION WHEN OTHERS THEN');
--       END LOOP; END $r$;
--   re-apply the orchestrator body from
--   20260810230106_audit_20260810_precompute_split_m2_orchestrator_procedure.sql,
--   then: DROP FUNCTION IF EXISTS public.rpc_thp_sentinel_failures_since(timestamptz);
--   (drop the helper LAST -- the orchestrator calls it, so dropping it first
--   leaves a tick window where the procedure errors on a missing function.)

-- 1. Make the existing sentinel handler reachable on a timeout, in all 8 legs.
--    Rewritten off pg_get_functiondef so every leg keeps its own body, its own
--    statement_timeout, SECURITY DEFINER and search_path byte-for-byte; only the
--    exception clause changes. Self-verifying: it refuses to apply if the clause
--    shape moved or the leg count is not 8.
DO $mig$
DECLARE
  r        record;
  v_def    text;
  v_new    text;
  v_count  int := 0;
BEGIN
  FOR r IN
    SELECT oid, proname
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname LIKE 'rpc\_thp\_leg\_%'
     ORDER BY proname
  LOOP
    v_def := pg_get_functiondef(r.oid);

    IF position('EXCEPTION WHEN query_canceled OR OTHERS THEN' in v_def) > 0 THEN
      v_count := v_count + 1;      -- already migrated; idempotent re-run
      CONTINUE;
    END IF;

    IF position('EXCEPTION WHEN OTHERS THEN' in v_def) = 0 THEN
      RAISE EXCEPTION
        'leg % does not carry the expected handler clause - inspect before migrating',
        r.proname;
    END IF;

    v_new := replace(v_def,
                     'EXCEPTION WHEN OTHERS THEN',
                     'EXCEPTION WHEN query_canceled OR OTHERS THEN');
    EXECUTE v_new;
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 8 THEN
    RAISE EXCEPTION 'expected 8 rpc_thp_leg_* functions, handled %', v_count;
  END IF;
END
$mig$;

-- 2. The sentinel read has to be SECURITY DEFINER, and that is not a style choice.
--    The orchestrator runs as its INVOKER (pg_cron's cron_heavy) -- measured:
--      has_table_privilege('cron_heavy','rpc_trust_health_precompute','SELECT') = false
--    The legs can write that table only because each leg is itself SECURITY
--    DEFINER. So reading it inline from the procedure would have failed with a
--    permission error on EVERY tick -- an honesty fix that manufactures the
--    outage it was meant to report. This helper carries the privilege instead,
--    leaving the procedure's own posture untouched.
CREATE OR REPLACE FUNCTION public.rpc_thp_sentinel_failures_since(p_since timestamptz)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $fn$
  SELECT string_agg(metric, ', ' ORDER BY metric)
    FROM public.rpc_trust_health_precompute
   WHERE value = 999
     AND computed_at >= p_since;
$fn$;

-- A new function's default EXECUTE grant is to PUBLIC, which survives a revoke
-- from anon/authenticated and would trip check_secdef_anon_exec_drift().
REVOKE EXECUTE ON FUNCTION public.rpc_thp_sentinel_failures_since(timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.rpc_thp_sentinel_failures_since(timestamptz) TO cron_heavy, service_role;

-- 3. Keep the job status honest. Legs no longer abort the chain, so without this
--    the procedure would always report success even when a leg fell back to 999.
--    Posture is deliberately UNCHANGED from the live definition: plain plpgsql,
--    no SECURITY DEFINER, no SET search_path. The legs supply their own
--    privileges and the helper above supplies the read.
CREATE OR REPLACE PROCEDURE public.rpc_trust_health_precompute_refresh_p()
LANGUAGE plpgsql
AS $proc$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_which   text;
BEGIN
  PERFORM public.rpc_thp_leg_panini();              COMMIT;
  PERFORM public.rpc_thp_leg_pinnacle_fmv_share();  COMMIT;
  PERFORM public.rpc_thp_leg_pack_ev();             COMMIT;
  PERFORM public.rpc_thp_leg_fmv_sanity();          COMMIT;
  PERFORM public.rpc_thp_leg_serial_supply();       COMMIT;
  PERFORM public.rpc_thp_leg_fmv_coverage();        COMMIT;
  PERFORM public.rpc_thp_leg_board_liveness();      COMMIT;
  PERFORM public.rpc_thp_leg_impossible_parallel(); COMMIT;

  -- Every leg has now had its attempt and its writes are committed, so raising
  -- here loses no work. It exists so a leg that fell back to its sentinel still
  -- shows up in cron.job_run_details instead of passing silently.
  v_which := public.rpc_thp_sentinel_failures_since(v_started);

  IF v_which IS NOT NULL THEN
    RAISE EXCEPTION
      'trust precompute: leg(s) fell back to the 999 sentinel this run: %', v_which;
  END IF;
END
$proc$;

COMMENT ON PROCEDURE public.rpc_trust_health_precompute_refresh_p() IS
  'Runs the 8 rpc_thp_leg_* metric legs, committing after each so one slow leg '
  'cannot roll back the others. Each leg traps query_canceled itself and records '
  'the 999 sentinel, so a statement timeout no longer skips every downstream leg '
  '(audit_20260815). Re-raises at the end if any leg used its sentinel, keeping '
  'cron.job_run_details honest. See rpc_trust_health_precompute_refresh (no _p) '
  'for the legacy monolith: it has ZERO callers -- read cron.job.command, not the '
  'name, to find what a schedule actually runs.';
