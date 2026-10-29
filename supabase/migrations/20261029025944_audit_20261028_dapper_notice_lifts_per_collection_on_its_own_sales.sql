-- audit_20261028_dapper_notice_lifts_per_collection_on_its_own_sales
-- anon-exec: unchanged (restore_dapper_maintenance_notice) — CREATE OR REPLACE of an existing fn with the same signature; ACL preserved, verified has_function_privilege anon=false before and after.
--
-- 2026-10-28 ~8:10 PM PT (Cowork cloud; Trevor: "Keep going and do it all"). The 10-27 maintenance notice
-- (20261027192917) lifted itself at 3:07 PM PT 10-28 on ALL FOUR Dapper collections because the Atlas market feed
-- (Top Shot's backend) answered again at 2:57 PM. Measured ~8:00 PM PT that this was premature:
--   - nbatopshot.com, nflallday.com and disneypinnacle.com still 307 to maintenance.<site> (status.json "maintenance");
--     laligagolazos.com answers 200;
--   - Top Shot: 9 on-chain sales since 6:57 PM PT from 3 buyers (pre-outage mean 96.5 sales/hour);
--   - All Day: 0 sales since 8:33 AM PT 10-27 (pre-outage mean 16.9/hour); Pinnacle: 0 since 9:28 AM PT 10-27 (13.1/hour).
-- So Top Shot / All Day / Pinnacle pages read as live markets while the public cannot trade. A backend answering is
-- not a market reopening, and one collection's signal says nothing about the other three.
--
-- (1) Re-apply the notice to nba_top_shot, nfl_all_day, disney_pinnacle (same mechanism: marketplace kept verbatim
--     under marketplace_saved, status 'degraded', a corrected note). Golazos stays healthy (its site is up).
-- (2) restore_dapper_maintenance_notice() now lifts EACH collection on its OWN sales: in the last 2 hours at least
--     25 % of its pre-outage 2-hour volume (TS 48, AD 8, Pinnacle 6 — means measured over 10-20 9 AM .. 10-27 9 AM PT)
--     AND at least 5 distinct buyers. Pinnacle reads pinnacle_sales. Backstop moves to 2026-11-04 15:00 UTC (8 AM PT)
--     — a week, not two days, now that the lift is evidence-based. The cron unschedules itself only when no collection
--     still carries marketplace_saved.
-- (3) pg_cron 'dapper-maintenance-notice-restore' re-scheduled every 10 min (7,17,…,57).
-- Revert: SELECT public.restore_dapper_maintenance_notice(true);  -- lifts all notices now and unschedules
--         (then re-apply the 20261027192917 body to restore the old atlas-only rule).

UPDATE public.collection_config cc
   SET metadata = jsonb_set(
         jsonb_set(cc.metadata, '{marketplace_saved}', cc.metadata->'marketplace'),
         '{marketplace}',
         (cc.metadata->'marketplace')
           || jsonb_build_object(
                'status', 'degraded',
                'notes', 'Dapper''s marketplace is still coming back from maintenance (down since about 9:30 AM PT on Oct 27; its site still shows a maintenance page). Listings, asks and deals here may be out of date and most can''t be bought until trading is back; this notice clears itself when it is. FMV and portfolio tools still work.',
                'last_verified_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
  FROM public.collections c
 WHERE c.id = cc.collection_id
   AND c.slug IN ('nba_top_shot', 'nfl_all_day', 'disney_pinnacle')
   AND NOT (cc.metadata ? 'marketplace_saved')
   AND jsonb_typeof(cc.metadata->'marketplace') = 'object';

CREATE OR REPLACE FUNCTION public.restore_dapper_maintenance_notice(p_force boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_backstop boolean := now() >= timestamptz '2026-11-04 15:00:00+00';
  v_rows     integer := 0;
  v_detail   jsonb := '{}'::jsonb;
  r          record;
  v_sales    integer;
  v_buyers   integer;
  v_need     integer;
  v_lift     boolean;
BEGIN
  FOR r IN
    SELECT cc.collection_id, c.slug
      FROM public.collection_config cc JOIN public.collections c ON c.id = cc.collection_id
     WHERE cc.metadata ? 'marketplace_saved'
  LOOP
    -- 25 % of the pre-outage 2-hour volume (hourly means measured 10-20 9 AM .. 10-27 9 AM PT).
    v_need := CASE r.slug WHEN 'nba_top_shot' THEN 48 WHEN 'nfl_all_day' THEN 8 WHEN 'disney_pinnacle' THEN 6 ELSE 5 END;
    IF r.slug = 'disney_pinnacle' THEN
      SELECT count(*), count(DISTINCT p.buyer_address) INTO v_sales, v_buyers
        FROM public.pinnacle_sales p WHERE p.sold_at > now() - interval '2 hours';
    ELSE
      SELECT count(*), count(DISTINCT s.buyer_address) INTO v_sales, v_buyers
        FROM public.sales s WHERE s.collection_id = r.collection_id AND s.sold_at > now() - interval '2 hours';
    END IF;
    v_lift := p_force OR v_backstop OR (v_sales >= v_need AND v_buyers >= 5);
    v_detail := v_detail || jsonb_build_object(r.slug, jsonb_build_object(
      'sales_2h', v_sales, 'buyers_2h', v_buyers, 'need', v_need, 'lifted', v_lift));
    IF v_lift THEN
      UPDATE public.collection_config
         SET metadata = jsonb_set(metadata, '{marketplace}', metadata->'marketplace_saved') - 'marketplace_saved'
       WHERE collection_id = r.collection_id AND metadata ? 'marketplace_saved';
      v_rows := v_rows + 1;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.collection_config WHERE metadata ? 'marketplace_saved') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'dapper-maintenance-notice-restore';
  END IF;

  PERFORM public.log_pipeline_run('dapper-maintenance-notice', v_started, v_rows, v_rows, 0, true, NULL,
    NULL, NULL, NULL, jsonb_build_object('source', 'audit_20261028', 'restored', v_rows,
      'reason', CASE WHEN p_force THEN 'forced' WHEN v_backstop THEN 'backstop' ELSE 'own_sales' END,
      'collections', v_detail));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('dapper-maintenance-notice', v_started, 0, 0, 0, false, SQLERRM,
    NULL, NULL, NULL, jsonb_build_object('source', 'audit_20261028', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

SELECT cron.schedule('dapper-maintenance-notice-restore', '7,17,27,37,47,57 * * * *',
  'SELECT public.restore_dapper_maintenance_notice();');
