-- audit_20260815_revert_thp_legs_catch_query_canceled
--
-- REVERT of audit_20260815_thp_legs_catch_query_canceled, same session, ~15 min
-- later. The fix was right about the DEFECT and wrong about the REMEDY, and what
-- decided it was a measurement taken AFTER applying rather than before.
--
-- STILL TRUE, and worth keeping (the defect is real and now unfixed-by-design):
--   Every rpc_thp_leg_* handler is `EXCEPTION WHEN OTHERS`. PostgreSQL excludes
--   QUERY_CANCELED from OTHERS, so the 999 sentinel is UNREACHABLE on a timeout
--   -- verified empirically, and corroborated by `where value = 999` returning
--   ZERO rows, ever. A timed-out leg therefore keeps its stale value AND its
--   stale computed_at, and its error aborts the CALL, skipping every leg after
--   it. Only trust_precompute_max_age_hours notices.
--
-- WHAT THE FIX GOT WRONG -- three measurements, none of which I had first:
--   1. A function-level `SET statement_timeout` does NOT bind statements inside
--      the function. pg_temp probe: 300ms declared, pg_sleep(5) ran to
--      completion. So the legs' 60/90/120/180/240/300/480s declarations are ALL
--      INERT. Second instance of this trap today, after 8918307c on the drain
--      seeders -- a declared per-unit timeout that looks governing and is not.
--   2. The real budget is cron_heavy's ROLE-level statement_timeout=600s, shared
--      by the entire CALL. Legs 1-7 burned 517s (18:58:00 -> 19:06:37); leg 8
--      needs ~78s and got ~83s. It died at the boundary, not on its own merits.
--      My "the timer is re-armed per leg" claim was inferred from two legs of
--      217s and 209s completing in one CALL. The inference was wrong.
--   3. Decisive: after a cancel is caught, the timer is NOT re-armed. Probe at
--      statement_timeout=500ms -- first pg_sleep(3) cancelled and caught, second
--      pg_sleep(3) RAN TO COMPLETION: 'TAIL_UNBOUNDED ran_for=3.50s'.
--
-- So catching query_canceled buys a reachable sentinel at the price of running
-- every REMAINING leg with no timeout at all, holding a pooled connection on the
-- 2GB instance whose saturation caused the timeout in the first place. plpgsql
-- exposes no way to re-arm mid-statement, so no in-procedure variant keeps the
-- benefit without the hazard. Trading a bounded failure for an unbounded one is
-- the wrong trade.
--
-- THE REAL FIX IS STRUCTURAL and is FILED, not taken here: give each leg its own
-- TOP-LEVEL statement -- 8 pg_cron entries instead of one orchestrator -- so each
-- gets a fresh 600s budget, no leg's timeout can reach another, and
-- cron.job_run_details names the failing leg directly. That is a scheduling
-- change on the trust path and wants its own deliberate window.
-- See docs/overnight/inbox/2026-08-15T2240Z-the-999-sentinel-is-unreachable-on-a-timeout.md

-- 1. Restore the orchestrator FIRST, so nothing calls the helper before it drops.
CREATE OR REPLACE PROCEDURE public.rpc_trust_health_precompute_refresh_p()
LANGUAGE plpgsql
AS $proc$
BEGIN
  PERFORM public.rpc_thp_leg_panini();              COMMIT;
  PERFORM public.rpc_thp_leg_pinnacle_fmv_share();  COMMIT;
  PERFORM public.rpc_thp_leg_pack_ev();             COMMIT;
  PERFORM public.rpc_thp_leg_fmv_sanity();          COMMIT;
  PERFORM public.rpc_thp_leg_serial_supply();       COMMIT;
  PERFORM public.rpc_thp_leg_fmv_coverage();        COMMIT;
  PERFORM public.rpc_thp_leg_board_liveness();      COMMIT;
  PERFORM public.rpc_thp_leg_impossible_parallel(); COMMIT;
END;
$proc$;

COMMENT ON PROCEDURE public.rpc_trust_health_precompute_refresh_p() IS NULL;

-- 2. Restore the original handler clause on all 8 legs, self-verifying as before.
DO $rev$
DECLARE
  r       record;
  v_def   text;
  v_new   text;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT oid, proname
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname LIKE 'rpc\_thp\_leg\_%'
     ORDER BY proname
  LOOP
    v_def := pg_get_functiondef(r.oid);

    IF position('EXCEPTION WHEN query_canceled OR OTHERS THEN' in v_def) = 0 THEN
      v_count := v_count + 1;      -- already reverted; idempotent
      CONTINUE;
    END IF;

    v_new := replace(v_def,
                     'EXCEPTION WHEN query_canceled OR OTHERS THEN',
                     'EXCEPTION WHEN OTHERS THEN');
    EXECUTE v_new;
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 8 THEN
    RAISE EXCEPTION 'expected 8 rpc_thp_leg_* functions, handled %', v_count;
  END IF;
END
$rev$;

-- 3. Drop the helper last -- it is now unreferenced.
DROP FUNCTION IF EXISTS public.rpc_thp_sentinel_failures_since(timestamptz);
