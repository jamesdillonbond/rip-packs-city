-- audit_20261027 — Dapper maintenance notice on the four Dapper-run collections, lifted by the data, not a clock.
--
-- Dapper's marketplaces stopped ~9:30 AM PT 2026-10-27 (last Top Shot sale 9:29:09, Pinnacle 9:28:57; Dapper storefront
-- events exactly 0 from the 9:56 AM tick; Atlas 502 from 10:03 AM). Trevor 2026-10-27 ~12:10 PM PT: "Dapper is
-- currently down for maintenance until tomorrow." Every listing, ask and deal on these collections is as of that
-- morning and cannot be bought until Dapper returns, while the pages still read as live markets.
--
-- (1) Top Shot / All Day / Pinnacle / Golazos: collection_config.metadata.marketplace is kept VERBATIM under
--     metadata.marketplace_saved, then status := 'degraded' with a maintenance note. MarketplaceStatusBanner renders a
--     'degraded' row's notes on the overview, collection, sets, sniper and edition pages (nothing else branches on it;
--     buy_ctas_enabled is untouched).
-- (2) restore_dapper_maintenance_notice(): puts marketplace_saved back once Dapper is demonstrably back — 2+ ok
--     atlas-market-feed runs in the last 20 min (the Atlas market feed is Dapper's own backend; it has failed every
--     tick since 10:03 AM) — or at the backstop 2026-10-30 07:00 UTC (12 AM PT 10-30) so a notice can never outlive
--     its cause by more than two days. A fixed expiry alone would be wrong both ways (early end → a false "down"
--     banner; overrun → a silent live-looking market). Logs pipeline 'dapper-maintenance-notice'.
-- (3) pg_cron 'dapper-maintenance-notice-restore' every 10 min (7,17,…,57 — off the stagger ban); it unschedules
--     itself after restoring.
--
-- anon-exec: revoked (restore_dapper_maintenance_notice) — new fn, pg_cron only; REVOKE FROM PUBLIC, anon, authenticated below.
-- Revert (manual, any time): SELECT public.restore_dapper_maintenance_notice(true);  -- forces the restore + unschedule

UPDATE public.collection_config cc
   SET metadata = jsonb_set(
         jsonb_set(cc.metadata, '{marketplace_saved}', cc.metadata->'marketplace'),
         '{marketplace}',
         (cc.metadata->'marketplace')
           || jsonb_build_object(
                'status', 'degraded',
                'notes', 'Dapper is down for maintenance (since about 9:30 AM PT on Oct 27; expected back Oct 28). Listings, asks and deals here are as of that morning and can''t be bought until Dapper returns; new sales resume when it does. FMV and portfolio tools still work.',
                'last_verified_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
  FROM public.collections c
 WHERE c.id = cc.collection_id
   AND c.slug IN ('nba_top_shot', 'nfl_all_day', 'disney_pinnacle', 'laliga_golazos')
   AND NOT (cc.metadata ? 'marketplace_saved')
   AND jsonb_typeof(cc.metadata->'marketplace') = 'object';

CREATE OR REPLACE FUNCTION public.restore_dapper_maintenance_notice(p_force boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ok_runs integer;
  v_backstop boolean := now() >= timestamptz '2026-10-30 07:00:00+00';
  v_rows integer := 0;
  v_reason text;
BEGIN
  SELECT count(*) INTO v_ok_runs
    FROM public.pipeline_runs
   WHERE pipeline = 'atlas-market-feed' AND ok AND started_at > now() - interval '20 minutes';

  IF p_force OR v_backstop OR v_ok_runs >= 2 THEN
    v_reason := CASE WHEN p_force THEN 'forced' WHEN v_ok_runs >= 2 THEN 'atlas_recovered' ELSE 'backstop' END;
    UPDATE public.collection_config
       SET metadata = jsonb_set(metadata, '{marketplace}', metadata->'marketplace_saved') - 'marketplace_saved'
     WHERE metadata ? 'marketplace_saved';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'dapper-maintenance-notice-restore';
  END IF;

  PERFORM public.log_pipeline_run('dapper-maintenance-notice', v_started, v_ok_runs, v_rows, 0, true, NULL,
    NULL, NULL, NULL, jsonb_build_object('source', 'audit_20261027', 'atlas_ok_runs_20m', v_ok_runs,
                                         'restored', v_rows, 'reason', v_reason));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('dapper-maintenance-notice', v_started, 0, 0, 0, false, SQLERRM,
    NULL, NULL, NULL, jsonb_build_object('source', 'audit_20261027', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.restore_dapper_maintenance_notice(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_dapper_maintenance_notice(boolean) TO postgres, service_role;

SELECT cron.schedule('dapper-maintenance-notice-restore', '7,17,27,37,47,57 * * * *',
                     'SELECT public.restore_dapper_maintenance_notice()');
