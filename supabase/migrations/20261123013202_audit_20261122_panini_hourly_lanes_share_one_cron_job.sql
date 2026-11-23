-- audit_20261122_panini_hourly_lanes_share_one_cron_job — 2026-11-22 ~5:45 PM PT (Claude Code cloud; Trevor:
-- "Yes proceed with all of those" — the lane-budget item).
--
-- WHY. Lane budget (strategy-2026-11-22 §4, focus.md 11-22 ~10:20 AM PT): no new pg_cron job unless the same change
-- retires one; baseline 318 active. Job 915 `panini-pack-ev-tier-shadow` (`49 * * * *`, added 11:49 AM PT) had no
-- paired retirement; with it the count read 320 (job 913's pair is job 901, scheduled to retire 11-25).
--
-- WHAT. One pg_cron job runs both hourly Panini lanes. A procedure, so it can COMMIT between them: neither lane's
-- writes can be rolled back by the other's failure, and each runs in its own guarded block (query_canceled named,
-- R118) so one lane's kill cannot stop the other. Each function keeps its own pipeline_runs logging, unchanged.
--   * job 914 `panini-edition-supply-obs` now CALLs public.run_panini_hourly_lanes() at :49 (supply obs moves :54 → :49;
--     it is an hourly ledger reading, so the 5-minute shift changes nothing it measures);
--   * job 915 `panini-pack-ev-tier-shadow` is unscheduled.
-- Measured 24 h before: supply_obs 1–2 s, tier shadow 70–81 s, 0 failures each.
-- Active jobs 320 → 319 (→ 318 when job 901 retires as scheduled).
--
-- REVERT: SELECT cron.schedule('panini-pack-ev-tier-shadow', '49 * * * *', 'select public.refresh_panini_pack_ev_tier_shadow()');
--         SELECT cron.alter_job(914, schedule => '54 * * * *', command => 'select public.record_panini_edition_supply_obs()');
--         DROP PROCEDURE public.run_panini_hourly_lanes();

DO $guard$
BEGIN
  IF (SELECT command FROM cron.job WHERE jobid = 914) IS DISTINCT FROM 'select public.record_panini_edition_supply_obs()'
     OR (SELECT schedule FROM cron.job WHERE jobid = 914) IS DISTINCT FROM '54 * * * *' THEN
    RAISE EXCEPTION 'job 914 is not the expected panini-edition-supply-obs entry; re-read before merging';
  END IF;
  IF (SELECT command FROM cron.job WHERE jobid = 915) IS DISTINCT FROM 'select public.refresh_panini_pack_ev_tier_shadow()'
     OR (SELECT jobname FROM cron.job WHERE jobid = 915) IS DISTINCT FROM 'panini-pack-ev-tier-shadow' THEN
    RAISE EXCEPTION 'job 915 is not the expected panini-pack-ev-tier-shadow entry; re-read before merging';
  END IF;
END
$guard$;

CREATE OR REPLACE PROCEDURE public.run_panini_hourly_lanes()
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
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

SELECT cron.alter_job(914, schedule => '49 * * * *', command => 'CALL public.run_panini_hourly_lanes()');
SELECT cron.unschedule(915);
