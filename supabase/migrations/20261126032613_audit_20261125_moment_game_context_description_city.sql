-- audit_20261125_moment_game_context_description_city
--
-- A back-to-back with no recorded teams is settled by the Moment's description naming the opponent. Top
-- Shot's descriptions name the opponent's CITY as often as its nickname ("against Detroit"). Measured at
-- 7:35 PM PT: of 58 covered editions left without a game line on a back-to-back, the city settles 38; on
-- the 20 back-to-backs the recorded teams already settle (ground truth), the city named a candidate 16
-- times and agreed with the teams 16 / 16 (0 disagreements). The description now counts as evidence when it
-- names the opponent's nickname OR city (still 1 point; the recorded teams stay 2). Body otherwise
-- identical to 20261126031648 (live prosrc md5 verified).
--
-- Revert: re-apply get_moment_game_context from 20261126031648_audit_20261125_moment_game_context_team_placeholders.sql.

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
  v_n      int;
  v_top    int;
  v_tops   int;
  v_home   text;
  v_away   text;
begin
  select e.player_id, e.game_date, c.slug, e.home_team, e.away_team, e.description into v_e
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
  -- The edition's two teams as nicknames ("Los Angeles Clippers" -> "clippers"), trimmed; a
  -- placeholder ("N/A") or a missing side means the teams are not recorded.
  v_home := nullif(lower(regexp_replace(btrim(coalesce(v_e.home_team, '')), '^.*\s', '')), '');
  v_away := nullif(lower(regexp_replace(btrim(coalesce(v_e.away_team, '')), '^.*\s', '')), '');
  if v_home = 'n/a' or v_away = 'n/a' or v_home is null or v_away is null then
    v_home := null;
    v_away := null;
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

  -- The game: every stored game on the Moment's date, read as the US date OR the UTC date — Top
  -- Shot dates Moments both ways (Giannis 2026-11-14 is the US date of the DET game; Brunson
  -- 2025-12-19, recorded Pacers vs Knicks, is the UTC date of the IND game the night before).
  --   · one game          → it, unless the edition records its teams and this opponent is not one;
  --   · two (back-to-back) → the one whose opponent the edition's teams name (2 points) or its
  --                          description names, by nickname or city (1 point), if exactly one scores
  --                          highest; else none.
  -- No line beats a wrong one: the season line still shows.
  with cand as (
    select l.*,
           lower(regexp_replace(coalesce(l.opponent_name, ''), '^.*\s', '')) as opp_nick
      from public.player_gamelog_lines l
     where l.espn_league = v_el and l.espn_id = v_i.espn_id
       and (l.game_date = v_e.game_date or l.game_date_utc = v_e.game_date)
  ), scored as (
    select c.*,
           (case when v_home is not null and c.opp_nick in (v_home, v_away) then 2 else 0 end)
         + (case when v_e.description is not null and c.opp_nick <> ''
                  and (v_e.description ~ ('\m' || regexp_replace(c.opponent_name, '^.*\s', '') || '\M')
                       or v_e.description ~ ('\m' || regexp_replace(c.opponent_name, '\s+\S+$', '') || '\M'))
                 then 1 else 0 end) as evidence
      from cand c
  )
  select count(*), max(evidence), count(*) filter (where evidence = (select max(evidence) from scored))
    into v_n, v_top, v_tops
    from scored;

  if v_n = 1 or (v_n > 1 and v_top > 0 and v_tops = 1) then
    select jsonb_build_object(
             'source', 'gamelog',
             'event_id', s.event_id,
             'game_date', s.game_date,
             'season_type', s.season_type_name,
             'at_vs', s.at_vs,
             'opponent_abbr', s.opponent_abbr,
             'opponent_name', s.opponent_name,
             'score', s.score,
             'result', s.result,
             'labels', to_jsonb(s.labels),
             'names', to_jsonb(s.names),
             'values', to_jsonb(s."values"))
      into v_game
      from (
        select c.*,
               (case when v_home is not null and c.opp_nick in (v_home, v_away) then 2 else 0 end)
             + (case when v_e.description is not null and c.opp_nick <> ''
                      and (v_e.description ~ ('\m' || regexp_replace(c.opponent_name, '^.*\s', '') || '\M')
                           or v_e.description ~ ('\m' || regexp_replace(c.opponent_name, '\s+\S+$', '') || '\M'))
                     then 1 else 0 end) as evidence,
               (v_home is not null and c.opp_nick not in (v_home, v_away)) as teams_disagree
          from (
            select l.*, lower(regexp_replace(coalesce(l.opponent_name, ''), '^.*\s', '')) as opp_nick
              from public.player_gamelog_lines l
             where l.espn_league = v_el and l.espn_id = v_i.espn_id
               and (l.game_date = v_e.game_date or l.game_date_utc = v_e.game_date)
          ) c
      ) s
     where not s.teams_disagree
     order by s.evidence desc, s.game_at
     limit 1;
  end if;

  -- The box-score lane (2026-10-01 on, US dates only) for a basketball game the game log has not
  -- reached yet — only when the night before is empty, since a UTC-dated Moment for a game the
  -- night before reads as this date too.
  if v_game is null and v_n = 0 and v_el in ('nba', 'wnba') then
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
       and not exists (select 1 from public.player_game_stats p
                        where p.league = v_el and p.espn_id = v_i.espn_id and p.game_date = v_e.game_date - 1)
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
