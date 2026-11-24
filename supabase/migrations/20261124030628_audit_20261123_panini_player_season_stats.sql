-- audit_20261123: Panini player SEASON STATS (2026-11-23 evening, Panini parity pass 2; Trevor: "Do it all").
--
-- Top Shot, All Day and Candy player pages carry ESPN "Season Stats" (get_player_season_stats, keyed through
-- player_identities by players.id). Panini player pages had Recent Games and Bio but no season stats: Panini's
-- players are not in player_identities — they reach ESPN through panini_espn_crosswalk (name_slug → espn_id, sport),
-- the same one-person crosswalk get_player_recent_games already reads for Panini. 1,740 crosswalked Panini players
-- have player_season_stats rows (11-23).
--
-- Same return shape as get_player_season_stats, so the page's PlayerSeasonStats renders it unchanged:
--   · the slugs must resolve to EXACTLY ONE ESPN athlete, else NULL (no feed — two athletes behind one key is not
--     a person; the page renders nothing, never another player's stats);
--   · league from the crosswalk's SPORT (basketball → nba, football → nfl, baseball → mlb; soccer has no season
--     lines → NULL), so an ESPN id is never read in another sport's namespace;
--   · espn_league: the label an existing player_identities row gives that (league, espn_id) (WNBA athletes are
--     league 'nba' + espn_league 'wnba'), else 'wnba' when the player's Panini cards are in a Womens Basketball
--     product, else the league.
-- Revert: DROP FUNCTION public.get_panini_player_season_stats(text[], integer);

-- anon-exec: revoked (get_panini_player_season_stats) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_panini_player_season_stats(p_slugs text[], p_seasons integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n int;
  v_espn text;
  v_sport text;
  v_label text;
  v_league text;
  v_espn_league text;
  v_rows jsonb;
  v_refreshed timestamptz;
BEGIN
  SELECT count(DISTINCT x.espn_id), min(x.espn_id), min(x.sport), min(x.player_label)
    INTO v_n, v_espn, v_sport, v_label
    FROM public.panini_espn_crosswalk x
   WHERE x.name_slug = ANY (p_slugs) AND x.espn_id IS NOT NULL;
  IF v_n IS DISTINCT FROM 1 THEN
    RETURN NULL;
  END IF;
  v_league := CASE v_sport WHEN 'basketball' THEN 'nba' WHEN 'football' THEN 'nfl' WHEN 'baseball' THEN 'mlb' END;
  IF v_league IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT i.espn_league INTO v_espn_league
    FROM public.player_identities i
   WHERE i.league = v_league AND i.espn_id = v_espn AND i.espn_league IS NOT NULL
   LIMIT 1;
  IF v_espn_league IS NULL AND v_league = 'nba' AND EXISTS (
       SELECT 1 FROM public.panini_editions pe
         JOIN public.panini_products pr ON pr.set_id = pe.product_set_id
        WHERE lower(btrim(pe.player_name)) = lower(btrim(v_label))
          AND pr.last_grid_sport ILIKE 'women%') THEN
    v_espn_league := 'wnba';
  END IF;

  WITH seasons AS (
    SELECT DISTINCT s.season
      FROM public.player_season_stats s
     WHERE s.league = v_league AND s.espn_id = v_espn AND s.season_type = 2
     ORDER BY s.season DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_seasons, 3), 20))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'season', s.season,
           'season_type', s.season_type,
           'category', s.category,
           'display_name', s.display_name,
           'team_slug', nullif(s.team_slug, ''),
           'is_total', s.is_total,
           'labels', to_jsonb(s.labels),
           'names', to_jsonb(s.names),
           'values', to_jsonb(s."values")
         ) ORDER BY s.season DESC, s.category, s.is_total DESC, s.team_slug), '[]'::jsonb),
         max(s.refreshed_at)
    INTO v_rows, v_refreshed
    FROM public.player_season_stats s
    JOIN seasons z ON z.season = s.season
   WHERE s.league = v_league AND s.espn_id = v_espn AND s.season_type = 2;

  RETURN jsonb_build_object(
    'league', v_league,
    'espn_id', v_espn,
    'espn_league', COALESCE(v_espn_league, v_league),
    'display_name', v_label,
    'stats_refreshed_at', NULL,
    'rows_refreshed_at', v_refreshed,
    'rows', v_rows
  );
END
$function$;

REVOKE ALL ON FUNCTION public.get_panini_player_season_stats(text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_player_season_stats(text[], integer) TO service_role;

COMMENT ON FUNCTION public.get_panini_player_season_stats(text[], integer) IS
  'Panini player season stats (2026-11-23): get_player_season_stats''s shape, keyed through panini_espn_crosswalk (exactly one ESPN athlete for the page''s slugs, league from the crosswalk sport; soccer → NULL). NULL = no feed.';
