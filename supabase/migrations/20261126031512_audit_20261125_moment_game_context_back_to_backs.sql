-- audit_20261125_moment_game_context_back_to_backs
--
-- 20261126020836 matched a Moment to the game on its US date first. Measured at 7:15 PM PT over 288 fetched
-- player-seasons: Top Shot dates Moments BOTH ways, and on a back-to-back the Moment's own record often names
-- the UTC-date game — Brunson 2025-12-19 (recorded Pacers vs Knicks: UTC match IND, US match PHI), Harden
-- 2026-03-25 (Cavaliers vs Magic: UTC match ORL), Josh Hart 2026-03-04, Wembanyama 2026-03-06, Veronica
-- Burton 2026-05-22; while Giannis 2026-11-14 and Melton 2026-10-24 are US-dated. No date rule alone is right.
--   · one game on the date (either reading) → it, unless the edition records its two teams and the opponent
--     is neither (nickname match, so "LA Clippers" = "Los Angeles Clippers");
--   · a back-to-back → the game whose opponent the edition's teams name (2) or its description names (1),
--     when exactly one scores highest; otherwise no game line (the season still shows);
--   · the box-score lane answers only when the night before is empty;
--   · moment_gamelog_targets re-reads a current season (a Moment in the last 30 days) daily, not weekly,
--     so a new Moment's game arrives the next day.
-- Bodies otherwise the live ones (get_moment_game_context from 20261126025114, moment_gamelog_targets from
-- 20261126021927; prosrc md5 verified equal to those files before this replace).
--
-- Revert: re-apply get_moment_game_context from 20261126025114 and moment_gamelog_targets from 20261126021927.

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
  --                          description names (1 point), if exactly one scores highest; else none.
  -- No line beats a wrong one: the season line still shows.
  with cand as (
    select l.*,
           lower(regexp_replace(coalesce(l.opponent_name, ''), '^.*\s', '')) as opp_nick
      from public.player_gamelog_lines l
     where l.espn_league = v_el and l.espn_id = v_i.espn_id
       and (l.game_date = v_e.game_date or l.game_date_utc = v_e.game_date)
  ), scored as (
    select c.*,
           (case when v_e.home_team is not null and v_e.away_team is not null
                  and c.opp_nick in (lower(regexp_replace(v_e.home_team, '^.*\s', '')),
                                     lower(regexp_replace(v_e.away_team, '^.*\s', '')))
                 then 2 else 0 end)
         + (case when v_e.description is not null and c.opp_nick <> ''
                  and v_e.description ~ ('\m' || regexp_replace(c.opponent_name, '^.*\s', '') || '\M')
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
               (case when v_e.home_team is not null and v_e.away_team is not null
                      and c.opp_nick in (lower(regexp_replace(v_e.home_team, '^.*\s', '')),
                                         lower(regexp_replace(v_e.away_team, '^.*\s', '')))
                     then 2 else 0 end)
             + (case when v_e.description is not null and c.opp_nick <> ''
                      and v_e.description ~ ('\m' || regexp_replace(c.opponent_name, '^.*\s', '') || '\M')
                     then 1 else 0 end) as evidence,
               (v_e.home_team is not null and v_e.away_team is not null
                and c.opp_nick not in (lower(regexp_replace(v_e.home_team, '^.*\s', '')),
                                       lower(regexp_replace(v_e.away_team, '^.*\s', '')))) as teams_disagree
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

CREATE OR REPLACE FUNCTION public.moment_gamelog_targets(p_limit int default 24)
returns table (espn_league text, espn_id text, season int)
language sql stable
set search_path = pg_catalog, public
as $$
  with ed as (
    select distinct coalesce(i.espn_league, i.league) as el, i.espn_id, e.game_date
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day')
      join public.player_identities i on i.player_id = e.player_id and i.espn_id is not null
     where e.game_date is not null and e.game_date >= date '2002-08-01'
       -- an All Day play with no game (Player/Team Melt, Draft Pick, an unfilled placeholder) has no line
       and (c.slug <> 'nfl_all_day' or (e.home_team is not null and e.away_team is not null))
  ), need as (
    select ed.el, ed.espn_id, public.moment_gamelog_season(ed.el, ed.game_date) as season, max(ed.game_date) as last_date
      from ed
     where ed.el in ('nba', 'wnba', 'nfl')
       and not exists (
         select 1 from public.player_gamelog_lines l
          where l.espn_league = ed.el and l.espn_id = ed.espn_id
            and l.game_date_utc between ed.game_date - 1 and ed.game_date + 1)
     group by 1, 2, 3
  )
  select n.el, n.espn_id, n.season
    from need n
    left join public.player_gamelog_fetches f
      on f.espn_league = n.el and f.espn_id = n.espn_id and f.season = n.season
   where f.espn_id is null
      or (f.status in ('error', 'requested') and f.attempts < 3 and f.requested_at < now() - interval '1 hour')
      -- a fetched season is re-read so a new Moment's game arrives: daily while the season is
      -- current (a Moment within the last 30 days), weekly after
      or (f.status = 'ok' and f.fetched_at < now() - (case when n.last_date >= current_date - 30
                                                          then interval '1 day' else interval '7 days' end))
   order by (f.espn_id is null) desc, n.last_date desc, n.espn_id
   limit greatest(1, least(coalesce(p_limit, 24), 100))
$$;
-- anon-exec: unchanged (moment_gamelog_targets) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-25.
