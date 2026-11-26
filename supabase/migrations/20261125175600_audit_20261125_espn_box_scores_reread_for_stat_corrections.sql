-- audit_20261125_espn_box_scores_reread_for_stat_corrections
--
-- Trevor 11-25 ("Yes do it all and update everything"), found checking the Wednesday rookie post.
-- MEASURED 2026-11-25 ~9:45 AM PT: `espn_gamelog_dispatch` fetches a box score only while
-- `box_ingested_at IS NULL`, so a game is read once (~2 h after it ends) and never again. ESPN applies
-- stat corrections later: Darryn Peterson's 11-11 game is 22 points on ESPN today (20 stored) and his 11-02
-- game 5 assists (6 stored) — the 11-02 row was read on 11-08, so a correction can land six days or more
-- after the game. The rookies board, the Wednesday rookie image and get_player_recent_games all showed his
-- line as 15.8 PPG / 4.1 APG; ESPN's is 15.9 / 4.0. Every other stat line in the 2026 rookie top 10 matched.
--
-- THE FIX: `espn_gamelog_restat(p_limit, p_days, p_league)` re-requests the box scores read longest ago
-- among completed games of the last p_days that were last read more than 24 h ago. The existing drain
-- already upserts player_game_stats on (league, event_id, espn_id, category) and stamps box_ingested_at,
-- so a re-read game moves to the back of the queue. pg_cron `rpc-espn-gamelog-restat` runs it hourly at
-- :05 (20 games; ~710 games in 30 days → each re-read every ~1.5 days for 45 days). :05 sits after
-- dispatch (:04) and before drain (:07), so the drain clears the requests before the next dispatch tick
-- and dispatch's in-flight guard is not tripped.
-- New function: SECURITY INVOKER, called by pg_cron as postgres only.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-espn-gamelog-restat');
--   DROP FUNCTION public.espn_gamelog_restat(integer, integer, text);

CREATE OR REPLACE FUNCTION public.espn_gamelog_restat(p_limit integer DEFAULT 20, p_days integer DEFAULT 45, p_league text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_req bigint;
  v_n   int := 0;
  e     record;
BEGIN
  FOR e IN
    SELECT ev.league, ev.event_id, lg.path
      FROM public.espn_game_events ev
      JOIN public.espn_leagues lg ON lg.league = ev.league AND lg.is_active
     WHERE ev.completed
       AND ev.box_ingested_at IS NOT NULL
       AND ev.box_ingested_at < now() - interval '24 hours'
       AND ev.starts_at > now() - make_interval(days => p_days)
       AND (p_league IS NULL OR ev.league = p_league)
       AND NOT EXISTS (SELECT 1 FROM public.espn_gamelog_requests r
                        WHERE r.event_id = ev.event_id AND r.league = ev.league AND r.drained_at IS NULL)
     ORDER BY ev.box_ingested_at, ev.event_id
     LIMIT p_limit
  LOOP
    v_req := net.http_get(
      url := 'https://site.api.espn.com/apis/site/v2/sports/' || e.path || '/summary?event=' || e.event_id,
      timeout_milliseconds := 30000);
    INSERT INTO public.espn_gamelog_requests (request_id, league, kind, event_id)
    VALUES (v_req, e.league, 'summary', e.event_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('restat_summaries', v_n, 'window_days', p_days, 'league', p_league);
END
$$;

-- anon-exec: revoked (espn_gamelog_restat) — a new fn that issues outbound HTTP; postgres (pg_cron) and service_role only.
REVOKE EXECUTE ON FUNCTION public.espn_gamelog_restat(integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.espn_gamelog_restat(integer, integer, text) TO postgres, service_role;

SELECT cron.schedule('rpc-espn-gamelog-restat', '5 * * * *', 'select public.espn_gamelog_restat()');
