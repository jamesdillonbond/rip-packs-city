-- audit_20260830_populate_pinnacle_wmc_fmv_moves_to_pg_cron
--
-- WHY: `populate-pinnacle-wmc-fmv` runs as a Vercel route (app/api/cron/populate-pinnacle-wmc-fmv, maxDuration 300, fired
-- hourly at :03 by cron-job.org). The RPC call inside it goes through PostgREST, whose ~120 s gateway cancels it: measured
-- 2026-08-30, every tick from 11:03Z to 15:03Z died at 125,260 ms `upstream request timeout` while the 10:07Z catalog
-- recompute waited to be synced -- Pinnacle wallet FMVs were 5.5 h stale. Migration 20260830153801 made the no-work ticks
-- return in < 1 s (`catalog_unchanged`), so the ONLY ticks that still need a real budget are the ~4 after a catalog
-- recompute, and those are exactly the ones the gateway kills. The same run as cron_heavy drained in 35 s.
--
-- WHAT: an hourly cron_heavy pg_cron job (600 s role budget, no gateway) through a wrapper that writes the SAME terminal
-- row the route writes (pipeline `populate-pinnacle-wmc-fmv`, rows_found = examined, rows_written = updated) and CATCHES
-- a statement cancel so a timed-out drain leaves an ok=false row, never silence. :09 so it runs after the route's :03 tick
-- has either finished (then this one reads `catalog_unchanged` in < 1 s) or been killed (then this one does the drain).
-- The cron-job.org entry "RPC Populate Pinnacle WMC FMV" can be disabled at leisure (console) -- until then the two are
-- idempotent against the watermark, not a double-fire.
--
-- REVERT: DO $$ BEGIN SET LOCAL ROLE cron_heavy; PERFORM cron.unschedule('rpc-populate-pinnacle-wmc-fmv'); END $$;
--         DROP FUNCTION public.run_populate_pinnacle_wmc_fmv_job();
-- anon-exec: run_populate_pinnacle_wmc_fmv_job (REVOKED from PUBLIC/anon/authenticated below; cron_heavy/postgres/service_role only)

CREATE OR REPLACE FUNCTION public.run_populate_pinnacle_wmc_fmv_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ok boolean := true;
  v_err text := NULL;
  v_res json;
  v_examined int := 0;
  v_updated int := 0;
  c_limit constant int := 10000;  -- same LIMIT_PER_RUN as the route
BEGIN
  BEGIN
    v_res := public.populate_pinnacle_wmc_fmv(c_limit);
    v_examined := coalesce((v_res->>'examined')::int, 0);
    v_updated := coalesce((v_res->>'updated')::int, 0);
  EXCEPTION WHEN OTHERS THEN
    -- includes 57014 query_canceled from the cron_heavy statement_timeout: the row below still lands.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run('populate-pinnacle-wmc-fmv', v_started, v_examined, v_updated,
                                  greatest(0, v_examined - v_updated), v_ok, v_err, 'disney_pinnacle', NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'limit', c_limit, 'via', 'pg_cron',
                                                     'reason', v_res->>'reason'));
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.run_populate_pinnacle_wmc_fmv_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_populate_pinnacle_wmc_fmv_job() TO cron_heavy, postgres, service_role;

DO $mig$
DECLARE v_new int;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-populate-pinnacle-wmc-fmv') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: rpc-populate-pinnacle-wmc-fmv already scheduled';
  END IF;
  SET LOCAL ROLE cron_heavy;
  v_new := cron.schedule('rpc-populate-pinnacle-wmc-fmv', '9 * * * *', 'SELECT public.run_populate_pinnacle_wmc_fmv_job();');
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_new AND username = 'cron_heavy' AND active) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: job % not active as cron_heavy', v_new;
  END IF;
  RAISE NOTICE 'rpc-populate-pinnacle-wmc-fmv scheduled as jobid % (cron_heavy, 9 * * * *)', v_new;
END
$mig$;
