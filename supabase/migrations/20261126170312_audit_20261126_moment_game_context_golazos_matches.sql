-- audit_20261126_moment_game_context_golazos_matches
--
-- The Moment slab's back for LaLiga Golazos: the match result, read from espn_soccer_matches (the lane
-- 20261126165600 / 165704 filled 545 scoreboard dates, 1,689 matches, 0 errors, 11-26 ~9:05 AM PT).
-- Pairing both clubs on the Moment's date or the day before: 572 / 575 editions match exactly one
-- completed match, none ambiguous; the 3 misses were Golazos' "Real Sporting" (Sporting Gijón), now an
-- alias in soccer_club_tokens. Spot-checked against the record: Real Madrid 2-6 Barcelona (2009-05-02),
-- Barcelona 5-0 Real Madrid (2010-11-29), Real Madrid 0-4 Barcelona (2022-03-20).
-- get_moment_game_context body otherwise identical to 20261126162015 (live prosrc md5 05484288… verified);
-- soccer_club_tokens otherwise identical to 20261126165600 (64b31f74… verified).
--
-- Revert: re-apply get_moment_game_context from 20261126162015_audit_20261126_moment_game_context_team_moments_without_player_id.sql
-- and soccer_club_tokens from 20261126165600_audit_20261126_golazos_match_results_lane.sql.

CREATE OR REPLACE FUNCTION public.soccer_club_tokens(p_name text)
returns text[]
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(t order by t), '{}'::text[])
    -- one alias: Golazos writes Sporting Gijón as "Real Sporting" (3 editions, 2008-2010)
    from regexp_split_to_table(lower(extensions.unaccent(regexp_replace(coalesce(p_name, ''), '^\s*Real Sporting\s*$', 'Sporting Gijón', 'i'))), '[^a-z0-9]+') t
   where t <> ''
     and length(t) > 1
     and t not in ('fc', 'cf', 'cd', 'ud', 'sd', 'rcd', 'rc', 'ca', 'cp', 'club', 'de', 'la', 'del', 'el', 'sad', 'balompie', 'futbol')
$$;
-- anon-exec: unchanged (soccer_club_tokens) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-26.

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
  v_subj   text;
  v_other  text;
  v_event  text;
  v_side   text;
begin
  select e.player_id, e.player_name, e.team_name, e.game_date, c.slug, e.home_team, e.away_team, e.description into v_e
    from public.editions e
    join public.collections c on c.id = e.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day', 'laliga_golazos')
   where e.id = p_edition_id;
  if v_e.game_date is null then
    return null;
  end if;

  -- LaLiga Golazos: the MATCH, from ESPN's LaLiga scoreboard (espn_soccer_matches). Both clubs pair —
  -- the edition's home with ESPN's home, its away with ESPN's away (club tokens, one inside the other) —
  -- on the Moment's date or the day before (Golazos dates some Moments a day late: 135 of 575, 11-26),
  -- completed matches only, exactly one or none. The player's side is read from the EDITION (its club is
  -- its home or away team), never from ESPN's names ("Espanyol de Barcelona" holds "barcelona").
  if v_e.slug = 'laliga_golazos' then
    if v_e.home_team is null or v_e.away_team is null then
      return null;
    end if;
    v_side := case when lower(btrim(coalesce(v_e.team_name, ''))) = lower(btrim(v_e.home_team)) then 'home'
                   when lower(btrim(coalesce(v_e.team_name, ''))) = lower(btrim(v_e.away_team)) then 'away' end;
    select count(*), min(x.event_id) into v_n, v_event
      from public.espn_soccer_matches x
     where x.league = 'esp.1'
       and x.match_date between v_e.game_date - 1 and v_e.game_date
       and x.completed
       and (public.soccer_club_tokens(x.home_name) <@ public.soccer_club_tokens(v_e.home_team)
            or public.soccer_club_tokens(v_e.home_team) <@ public.soccer_club_tokens(x.home_name))
       and (public.soccer_club_tokens(x.away_name) <@ public.soccer_club_tokens(v_e.away_team)
            or public.soccer_club_tokens(v_e.away_team) <@ public.soccer_club_tokens(x.away_name))
       and cardinality(public.soccer_club_tokens(x.home_name)) > 0
       and cardinality(public.soccer_club_tokens(x.away_name)) > 0
       and cardinality(public.soccer_club_tokens(v_e.home_team)) > 0
       and cardinality(public.soccer_club_tokens(v_e.away_team)) > 0;
    if v_n <> 1 then
      return null;
    end if;
    select jsonb_build_object(
             'source', 'match',
             'event_id', x.event_id,
             'game_date', x.match_date,
             'home_name', x.home_name,
             'away_name', x.away_name,
             'home_score', x.home_score,
             'away_score', x.away_score,
             'side', v_side)
      into v_game
      from public.espn_soccer_matches x
     where x.league = 'esp.1' and x.event_id = v_event;
    return jsonb_build_object(
      'league', 'laliga',
      'espn_league', 'laliga',
      'season', extract(year from (v_game->>'game_date')::date)::int,
      'moment_game_date', v_e.game_date,
      'season_rows', '[]'::jsonb,
      'game', v_game);
  end if;
  -- An All Day play without both teams is not a game: a Player/Team Melt (280 are dated to the
  -- 2023 opener), a Draft Pick, or a placeholder play All Day has not filled in. Its date names no
  -- game and no season, so the slab shows no stats for it.
  if v_e.slug = 'nfl_all_day' and (v_e.home_team is null or v_e.away_team is null) then
    return null;
  end if;

  -- A TEAM Moment (All Day's "One to Remember": the subject is one of the edition's own two teams,
  -- checked against nflallday.com/edition/5951 on 2026-11-26) has no player line; its back carries
  -- the team's result. The stored lines whose opponent is the OTHER team on that date were played
  -- by the subject team's players, so their score and result are the subject team's. Exactly one
  -- such game, or none.
  v_subj := lower(btrim(coalesce(v_e.player_name, '')));
  if v_subj <> '' and v_subj in (lower(btrim(coalesce(v_e.home_team, ''))), lower(btrim(coalesce(v_e.away_team, '')))) then
    v_other := case when v_subj = lower(btrim(v_e.home_team)) then btrim(v_e.away_team) else btrim(v_e.home_team) end;
    if v_other is null or v_other = '' or lower(v_other) = 'n/a' or lower(v_other) = v_subj then
      return null;
    end if;
    v_other := lower(regexp_replace(v_other, '^.*\s', ''));
    select count(distinct l.event_id), min(l.event_id), min(l.espn_league) into v_n, v_event, v_el
      from public.player_gamelog_lines l
     where l.espn_league = any (case when v_e.slug = 'nfl_all_day' then array['nfl'] else array['nba', 'wnba'] end)
       and (l.game_date = v_e.game_date or l.game_date_utc = v_e.game_date)
       and lower(regexp_replace(coalesce(l.opponent_name, ''), '^.*\s', '')) = v_other;
    if v_n <> 1 then
      return null;
    end if;
    select jsonb_build_object(
             'source', 'team',
             'event_id', l.event_id,
             'game_date', l.game_date,
             'season_type', l.season_type_name,
             'at_vs', l.at_vs,
             'opponent_abbr', l.opponent_abbr,
             'opponent_name', l.opponent_name,
             'score', l.score,
             'result', l.result)
      into v_game
      from public.player_gamelog_lines l
     where l.espn_league = v_el and l.event_id = v_event
       and lower(regexp_replace(coalesce(l.opponent_name, ''), '^.*\s', '')) = v_other
     limit 1;
    return jsonb_build_object(
      'league', v_el,
      'espn_league', v_el,
      'season', public.moment_gamelog_season(v_el, v_e.game_date),
      'moment_game_date', v_e.game_date,
      'season_rows', '[]'::jsonb,
      'game', v_game);
  end if;
  if v_e.player_id is null then
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
-- anon-exec: unchanged (get_moment_game_context) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-26.
