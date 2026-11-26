-- anon-exec: intentional — snapshot re-create with the SAME signature preserves the revoked ACL; verified post-apply: anon EXECUTE false (moment_gamelog_season)
-- anon-exec: intentional — snapshot re-create with the SAME signature preserves the revoked ACL; verified post-apply: anon EXECUTE false (get_moment_game_context)
-- 2026-11-25: RECORD-ONLY re-issue, no behaviour change. The Moment game-line migrations (20261126020013,
-- 20261126020836, 20261126021927) wrote their functions in lower case, and the DB-invariant pin extractor and
-- db-pin-points-at-the-newest-defining-migration match only the upper-case `CREATE OR REPLACE FUNCTION`.
-- This file re-issues the two live bodies verbatim so supabase/tests/get_moment_game_context.sql can pin them
-- (prosrc md5 checked against production before writing: moment_gamelog_season 487c7ab7011112528c614adf775e5365,
-- get_moment_game_context de5c42ba0780317772b5fa2c6889072a). CREATE OR REPLACE keeps owner and grants.
--
-- Revert: nothing to revert (bodies unchanged).

CREATE OR REPLACE FUNCTION public.moment_gamelog_season(p_espn_league text, d date)
returns int language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_espn_league = 'nba'  then extract(year from d)::int + (case when extract(month from d) >= 8 then 1 else 0 end)
    when p_espn_league = 'wnba' then extract(year from d)::int
    when p_espn_league = 'nfl'  then extract(year from d)::int - (case when extract(month from d) <= 3 then 1 else 0 end)
  end
$$;

CREATE OR REPLACE FUNCTION public.get_moment_game_context(p_edition_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_e      record;
  v_i      record;
  v_el     text;
  v_season int;
  v_rows   jsonb;
  v_game   jsonb;
begin
  select e.player_id, e.game_date, c.slug, e.home_team, e.away_team into v_e
    from public.editions e
    join public.collections c on c.id = e.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day')
   where e.id = p_edition_id;
  if v_e.player_id is null or v_e.game_date is null then
    return null;
  end if;
  -- An All Day play without both teams is not a game: a Player/Team Melt (280 are dated to the
  -- 2023 opener), a Draft Pick, or a placeholder play All Day has not filled in. Its date names no
  -- game and no season, so the slab shows no stats for it.
  if v_e.slug = 'nfl_all_day' and (v_e.home_team is null or v_e.away_team is null) then
    return null;
  end if;

  select i.league, i.espn_id, coalesce(i.espn_league, i.league) as el into v_i
    from public.player_identities i
   where i.player_id = v_e.player_id and i.espn_id is not null
   order by i.stats_refreshed_at desc nulls last
   limit 1;
  if v_i.espn_id is null or v_i.el not in ('nba', 'wnba', 'nfl') then
    return null;
  end if;
  v_el := v_i.el;
  v_season := public.moment_gamelog_season(v_el, v_e.game_date);

  select coalesce(jsonb_agg(jsonb_build_object(
           'category', s.category,
           'display_name', s.display_name,
           'team_slug', nullif(s.team_slug, ''),
           'is_total', s.is_total,
           'labels', to_jsonb(s.labels),
           'names', to_jsonb(s.names),
           'values', to_jsonb(s."values")
         ) order by s.category, s.is_total desc, s.team_slug), '[]'::jsonb)
    into v_rows
    from public.player_season_stats s
   where s.league = v_i.league and s.espn_id = v_i.espn_id and s.season = v_season and s.season_type = 2;

  select jsonb_build_object(
           'source', 'gamelog',
           'event_id', l.event_id,
           'game_date', l.game_date,
           'season_type', l.season_type_name,
           'at_vs', l.at_vs,
           'opponent_abbr', l.opponent_abbr,
           'opponent_name', l.opponent_name,
           'score', l.score,
           'result', l.result,
           'labels', to_jsonb(l.labels),
           'names', to_jsonb(l.names),
           'values', to_jsonb(l."values"))
    into v_game
    from public.player_gamelog_lines l
   where l.espn_league = v_el and l.espn_id = v_i.espn_id
     and (l.game_date = v_e.game_date or l.game_date_utc = v_e.game_date)
   order by (l.game_date = v_e.game_date) desc,
            (l.season_type_name ilike '%preseason%'),
            l.game_at
   limit 1;

  -- The box-score lane (2026-10-01 on) for a basketball game the game log has not reached yet.
  if v_game is null and v_el in ('nba', 'wnba') then
    select jsonb_build_object(
             'source', 'box',
             'event_id', g.event_id,
             'game_date', g.game_date,
             'at_vs', case when g.is_home then 'vs' else '@' end,
             'opponent_abbr', g.opponent_abbr,
             'did_not_play', g.did_not_play,
             'stats', g.stats)
      into v_game
      from public.player_game_stats g
     where g.league = v_el and g.espn_id = v_i.espn_id
       and g.game_date = v_e.game_date
     limit 1;
  end if;

  return jsonb_build_object(
    'league', v_i.league,
    'espn_league', v_el,
    'season', v_season,
    'moment_game_date', v_e.game_date,
    'season_rows', v_rows,
    'game', v_game);
end
$$;
