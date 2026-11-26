-- audit_20261125_moment_game_context_exact_date
--
-- get_moment_game_context picked a game by UTC date first and accepted any game within -2..+1 days.
-- Measured on the first scheduled tick of the moment-game-lines lane (2026-11-25 6:05 PM PT, 147
-- Top Shot editions covered): Top Shot dates its NBA Moments by the US game date — 40 match only the
-- US date, 0 only the UTC date — and 4 editions (Giannis, 2026-11-14) sit on a back-to-back where
-- the UTC-first order chose the 11-13 Cleveland game over the 11-14 Detroit game the Moment is from.
-- WNBA: 42 US-only, 13 UTC-only, 0 conflicts. So:
--   · the game must match the Moment's date EXACTLY, as the US date or (failing that) the UTC date —
--     a UTC-dated Moment (Lillard NBA Cup, 12-11 for the 12-10 ET game) still resolves;
--   · no nearest-day fallback: a near game is a different game, and no line beats a wrong one;
--   · the box-score fallback (US-dated) matches the date exactly too.
-- Body otherwise identical to 20261126020013 (live prosrc md5 31f4273c… verified equal to that
-- file before this replace).
--
-- Revert: re-apply the get_moment_game_context body of 20261126020013_audit_20261125_moment_game_lines.sql.

create or replace function public.get_moment_game_context(p_edition_id uuid)
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
  select e.player_id, e.game_date into v_e
    from public.editions e
    join public.collections c on c.id = e.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day')
   where e.id = p_edition_id;
  if v_e.player_id is null or v_e.game_date is null then
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

-- anon-exec: unchanged (get_moment_game_context) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-25.
