-- audit_20260810_precompute_split_m2_orchestrator_procedure
--
-- D34-prerequisite precompute split, stage M2 of 3 (plan:
-- docs/audits/precompute-split-plan-2026-08-10.md). Thin orchestrator that
-- runs the 7 M1 leg functions cheapest-first and COMMITs after each, so a
-- kill/timeout in a later leg can no longer roll back the metrics already
-- computed (the recurring 12:58Z-freeze failure).
--
-- ⚠ MUST be INVOKER-rights with NO `SET` clause and called as a single
-- statement: a SECURITY DEFINER procedure OR a SET clause puts the call in an
-- atomic context and COMMIT then fails 2D000 (measured in prod this session).
-- Every reference is schema-qualified instead of using SET search_path (a
-- runtime SET search_path would persist on the pooled connection). The
-- per-leg statement_timeout budget lives on the SECDEF leg FUNCTIONS (M1) —
-- statement_timeout does NOT re-arm per COMMIT, so it cannot live here.
-- pg_cron runs this as postgres; it only calls SECDEF leg fns (which run as
-- their definer), so the invoker downgrade loses no privilege.
--
-- INERT until M3 cuts the cron over; the monolith remains the live writer.
--
-- Revert: DROP PROCEDURE public.rpc_trust_health_precompute_refresh_p();

CREATE OR REPLACE PROCEDURE public.rpc_trust_health_precompute_refresh_p()
LANGUAGE plpgsql
AS $proc$
BEGIN
  -- cheapest-first, so a bad tick commits the most arms before the expensive tail
  PERFORM public.rpc_thp_leg_panini();              COMMIT;
  PERFORM public.rpc_thp_leg_pack_ev();             COMMIT;
  PERFORM public.rpc_thp_leg_fmv_sanity();          COMMIT;
  PERFORM public.rpc_thp_leg_serial_supply();       COMMIT;
  PERFORM public.rpc_thp_leg_fmv_coverage();        COMMIT;
  PERFORM public.rpc_thp_leg_board_liveness();      COMMIT;
  PERFORM public.rpc_thp_leg_impossible_parallel(); COMMIT;
END;
$proc$;

REVOKE EXECUTE ON PROCEDURE public.rpc_trust_health_precompute_refresh_p() FROM PUBLIC, anon, authenticated;
