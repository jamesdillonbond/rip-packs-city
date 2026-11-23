-- audit_20261122_panini_hourly_lanes_procedure_no_set_clause — 2026-11-22 ~5:53 PM PT (Claude Code cloud).
--
-- WHY. 20261123013202 created run_panini_hourly_lanes() with `SET search_path`, and a procedure with a SET clause
-- cannot COMMIT: the first run (job 914, 5:49 PM PT) failed "invalid transaction termination" and both lanes
-- missed that hour (rolled back whole; neither logged a run).
-- WHAT. Same body without the SET clause (every object is schema-qualified, so search_path does not matter).
-- REVERT: see 20261123013202's header (restore job 914 / re-schedule job 915).

CREATE OR REPLACE PROCEDURE public.run_panini_hourly_lanes()
 LANGUAGE plpgsql
AS $procedure$
BEGIN
  BEGIN
    PERFORM public.record_panini_edition_supply_obs();
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    RAISE WARNING 'run_panini_hourly_lanes: record_panini_edition_supply_obs failed: %', SQLERRM;
  END;
  COMMIT;
  BEGIN
    PERFORM public.refresh_panini_pack_ev_tier_shadow();
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    RAISE WARNING 'run_panini_hourly_lanes: refresh_panini_pack_ev_tier_shadow failed: %', SQLERRM;
  END;
  COMMIT;
END
$procedure$;

REVOKE EXECUTE ON PROCEDURE public.run_panini_hourly_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_panini_hourly_lanes() TO service_role;
