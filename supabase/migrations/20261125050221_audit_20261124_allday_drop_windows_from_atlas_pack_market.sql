-- audit_20261124_allday_drop_windows_from_atlas_pack_market
--
-- 2026-11-24 ~9:00 PM PT (Claude Code cloud, autonomous pass; Trevor: "Keep going").
-- WHY. Sentinel "Zero-Yield Lanes" WARN: allday-drop-windows ran clean and found nothing since 11-17. Its lane,
-- run_allday_drop_windows_lane() (pg_cron 623, every 5 min), walks Studio GraphQL searchDistributions at
-- api.production.studio-platform.dapperlabs.com, which has answered HTTP 530 since 11-17 4:23 PM PT (the 11-18 edge
-- port to Atlas, 016418226, missed this DB lane). Every run since: walk started daily, 0 pages, one "page 1: http
-- 530 error code: 1033" failure a day, ok=true the rest.
-- Impact today: none yet — all 3,228 All Day distributions carry a date and the newest (7714) has its window. But
-- 3,077 of them get their date ONLY from allday_drop_windows (get_wallet_pack_history / get_wallet_pack_summary fall
-- back to adw.start_time when pack_distributions.metadata has no start_time), so the next All Day drop would show
-- undated.
-- WHAT. atlas_pack_market (product 'nfl', refreshed every ~15 min by atlas_pack_market_tick from Atlas
-- SearchDistributions) already carries start_time / end_time per dist. Measured 11-24: of 3,211 dists in both tables,
-- start_time equal on all 3,201 that have one (0 differ), end_time equal on 3,210; every Atlas dist with a start_time is
-- already a window. New refresh_allday_drop_windows_from_atlas(): insert new dists, update a row only when its
-- start/end changed; price_usd and an existing title are never touched (the two sources use 0 vs NULL differently
-- for price; both readers use start_time only). A source whose newest row is > 2 h old fails the run (stale source is
-- not a clean empty). Job 623 is repointed to it every 30 min (the cadence watchlist allows 60 silent min) — no lane added, and the dead Studio calls stop.
-- run_allday_drop_windows_lane() is left in place (callerless) for the revert.
--
-- anon-exec: revoked (refresh_allday_drop_windows_from_atlas) — new function; REVOKE FROM PUBLIC, anon, authenticated below.
-- REVERT:
--   SELECT cron.alter_job(623, schedule := '2-57/5 * * * *', command := 'SELECT public.run_allday_drop_windows_lane();');
--   DROP FUNCTION public.refresh_allday_drop_windows_from_atlas();

CREATE OR REPLACE FUNCTION public.refresh_allday_drop_windows_from_atlas()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_source_rows int := 0;
  v_newest timestamptz;
  v_inserted int := 0;
  v_updated int := 0;
  v_err text := NULL;
BEGIN
  SELECT count(*) FILTER (WHERE start_time IS NOT NULL), max(observed_at)
    INTO v_source_rows, v_newest
    FROM public.atlas_pack_market WHERE product = 'nfl';

  IF v_newest IS NULL OR v_newest < now() - interval '2 hours' THEN
    v_err := format('atlas_pack_market nfl source stale (newest row %s) — nothing refreshed', coalesce(v_newest::text, 'none'));
  ELSE
    WITH src AS (
      SELECT a.dist_id, a.start_time, a.end_time, a.title, a.observed_at
        FROM public.atlas_pack_market a
       WHERE a.product = 'nfl' AND a.start_time IS NOT NULL
    ), up AS (
      INSERT INTO public.allday_drop_windows AS t (dist_id, start_time, end_time, title, fetched_at)
      SELECT dist_id, start_time, end_time, title, observed_at FROM src
      ON CONFLICT (dist_id) DO UPDATE
        SET start_time = excluded.start_time,
            end_time   = coalesce(excluded.end_time, t.end_time),
            title      = coalesce(t.title, excluded.title),
            fetched_at = excluded.fetched_at
        WHERE t.start_time IS DISTINCT FROM excluded.start_time
           OR (excluded.end_time IS NOT NULL AND t.end_time IS DISTINCT FROM excluded.end_time)
      RETURNING (xmax = 0) AS inserted
    )
    SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_inserted, v_updated FROM up;
  END IF;

  PERFORM public.log_pipeline_run('allday-drop-windows', v_started, v_source_rows, v_inserted + v_updated, 0,
    v_err IS NULL, v_err, 'nfl_all_day', NULL, NULL,
    jsonb_build_object('source', 'atlas_pack_market', 'source_newest_at', v_newest,
                       'inserted', v_inserted, 'updated', v_updated, 'via', 'audit_20261124'));
  RETURN jsonb_build_object('ok', v_err IS NULL, 'source_rows', v_source_rows, 'inserted', v_inserted,
                            'updated', v_updated, 'error', v_err);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_allday_drop_windows_from_atlas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_allday_drop_windows_from_atlas() TO postgres, service_role;

SELECT cron.alter_job(623, schedule := '23,53 * * * *', command := 'SELECT public.refresh_allday_drop_windows_from_atlas();');

DO $$
DECLARE v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobid = 623;
  IF v_cmd IS DISTINCT FROM 'SELECT public.refresh_allday_drop_windows_from_atlas();' THEN
    RAISE EXCEPTION 'job 623 was not repointed (command: %)', v_cmd;
  END IF;
END $$;
