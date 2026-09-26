-- audit_20260925_candy_wmc_fmv_resyncs_hourly_from_current_snapshots
--
-- known-issues #141. Candy MLB wallet_moments_cache.fmv_usd lagged the edition's current price:
-- measured 2026-09-25 ~7:00 PM PT, 13,308 of 25,600 Candy wmc rows differed from
-- edition_fmv_current (price or confidence). Example: munetaka-murakami-green cached $164.87 LOW
-- against a current $584.48 MEDIUM.
--
-- MECHANISM (inferred from fmv_snapshots history; pipeline_runs retention (~73 h) cannot show
-- 09-17): the edition carries TWO interleaved snapshot series — a MEDIUM $584.48 line and LOW
-- one-offs (last: $164.87 on 2026-09-17 21:16). The LOW value reached wmc. refresh_wmc_fmv_changed
-- (job 303) skips any edition whose newest price equals its previous one (the 2026-08-30 IO fix),
-- which is sound ONLY if wmc already holds the previous value. Once a transition is missed, every
-- later identical $584.48 snapshot is skipped, so the wrong cached value never heals. That is an
-- event-driven lane with no outcome check.
--
-- FIX: an outcome-based resync for Candy only. populate_wmc_fmv_from_snapshots(candy, p_force =>
-- true) already sets every Candy wmc row to its edition's latest snapshot (verified equal to
-- edition_fmv_current for all 125 Candy editions before running it). Run once by hand at
-- ~7:04 PM PT: 13,308 rows in 17 s; drift 13,308 → 0; a second (no-op) run took 0.13 s. This
-- migration schedules it hourly at :18 as cron_heavy (minute :18 had no hourly job) and logs every
-- run to pipeline_runs as `candy-wmc-fmv-resync` with ok derived from the call, so the lane is
-- visible, not silent.
--
-- Scoped to Candy on purpose: 25.6k rows. The force path over Top Shot (millions of rows) is
-- documented as ad-hoc remediation only (app/api/wmc-fmv-populate) and is not touched here.
--
-- anon-exec: revoked (run_candy_wmc_fmv_resync_job) — new function; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- REVERT: SELECT cron.unschedule('rpc-candy-wmc-fmv-resync');
--         DROP FUNCTION IF EXISTS public.run_candy_wmc_fmv_resync_job();

CREATE OR REPLACE FUNCTION public.run_candy_wmc_fmv_resync_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ok      boolean := true;
  v_err     text := NULL;
  v_updated int := NULL;
  c_candy   constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
BEGIN
  BEGIN
    v_updated := public.populate_wmc_fmv_from_snapshots(c_candy, true, 50000);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- includes 57014 from a statement_timeout: the row below still lands, and
    -- rows_written stays NULL (not 0) because nothing is known to have been written.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run('candy-wmc-fmv-resync', v_started, NULL, v_updated, NULL, v_ok, v_err,
                                  'candy_mlb', NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'via', 'pg_cron', 'mode', 'force', 'issue', '#141'));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.run_candy_wmc_fmv_resync_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_candy_wmc_fmv_resync_job() TO service_role, cron_heavy;

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-candy-wmc-fmv-resync',
  '18 * * * *',
  'SELECT public.run_candy_wmc_fmv_resync_job();'
);

RESET ROLE;

DO $$
DECLARE v_sched text; v_user text;
BEGIN
  SELECT schedule, username INTO v_sched, v_user
    FROM cron.job WHERE jobname = 'rpc-candy-wmc-fmv-resync';
  IF v_sched IS DISTINCT FROM '18 * * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user IS DISTINCT FROM 'cron_heavy' THEN RAISE EXCEPTION 'owner is not cron_heavy: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-candy-wmc-fmv-resync') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;
