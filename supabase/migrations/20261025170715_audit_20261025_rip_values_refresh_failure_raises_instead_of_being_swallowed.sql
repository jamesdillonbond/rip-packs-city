-- audit_20261025_rip_values_refresh_failure_raises_instead_of_being_swallowed
--
-- 2026-10-25 ~10:15 AM PT (Claude Code cloud). Follow-up to 20261025170047, same session, before its first
-- scheduled run (pg_cron 11:05 AM PT).
--
-- 20261025170047 gave refresh_topshot_pack_rip_values() an `EXCEPTION WHEN query_canceled OR OTHERS` that
-- logged ok=false and RETURNED — copied from refresh_panini_league_coverage. Caught by the DB-pin guard
-- before push: supabase/tests/mv_refresh_wrappers.sql exists to prove these wrappers FAIL LOUDLY (e.g. a
-- CONCURRENT refresh whose unique index was dropped raises 55000, forever). Swallowing turned that into a
-- `succeeded` row in cron.job_run_details and an ok=false row only an observer of pipeline_runs would read.
--
-- NOW: log the SUCCESS (ok = rows > 0) and let any failure raise, as it did before 20261025170047. Nothing
-- reads a failure row: get_pack_realized_ev_row only takes the MV while an ok run started within 13 h, and
-- pipeline_cadence_watchlist (`topshot-pack-rip-values`, 420 / 780 min) pages on the silence a failing
-- refresh leaves. ⚠ log_pipeline_run is in the same transaction as the refresh, so a raise rolls the
-- (never-written) log back with it — there is no half-logged state.
--
-- REVERT: re-apply the refresh body from 20261025170047 (swallowing) or 20260816080000 (bare).
--
-- anon-exec: unchanged (refresh_topshot_pack_rip_values) — CREATE OR REPLACE, same signature; ACL restated (postgres, service_role, cron_heavy).

CREATE OR REPLACE FUNCTION public.refresh_topshot_pack_rip_values()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_rip_values;
  SELECT count(*) INTO v_rows FROM public.mv_topshot_pack_rip_values;
  PERFORM public.log_pipeline_run('topshot-pack-rip-values', v_started, v_rows, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'refreshed to 0 rows' END,
    'nba-top-shot', NULL, NULL, jsonb_build_object('reads', 'get_pack_realized_ev_row, mv_topshot_pack_realized_ev'));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_topshot_pack_rip_values() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_pack_rip_values() TO postgres, service_role, cron_heavy;

DO $mig$
BEGIN
  IF has_function_privilege('anon', 'public.refresh_topshot_pack_rip_values()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon EXECUTE leaked on refresh_topshot_pack_rip_values';
  END IF;
  IF NOT has_function_privilege('cron_heavy', 'public.refresh_topshot_pack_rip_values()', 'EXECUTE') THEN
    RAISE EXCEPTION 'cron_heavy lost EXECUTE on refresh_topshot_pack_rip_values -- the pg_cron job would fail';
  END IF;
  IF position('EXCEPTION' in (SELECT prosrc FROM pg_proc WHERE proname = 'refresh_topshot_pack_rip_values')) > 0 THEN
    RAISE EXCEPTION 'refresh_topshot_pack_rip_values still swallows failures';
  END IF;
END
$mig$;
