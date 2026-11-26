-- DB invariant: get_moment_game_context picks THE game a Moment is from, or none (2026-11-25).
--
-- The back of the interactive Moment slab shows the player's line from the Moment's game and that
-- season's averages. Rules pinned here, each measured on production before it was written:
--   (a) Top Shot dates Moments BOTH ways — the US game date (Giannis 2026-11-14: DET) or the UTC date of
--       the tip-off (Brunson 2025-12-19, recorded Pacers vs Knicks: the IND game the night before, ET).
--       One game on the date, read either way, is that game;
--   (b) on a back-to-back (one game on each reading) the game whose opponent the edition's own teams
--       name wins (2 points), else the one its description names by nickname or city (1 point); a tie, or no evidence,
--       is NO game line — the season still shows (20261126031512);
--   (c) an edition that records its teams never gets a game against someone else;
--   (d) an All Day play without both teams (a Player/Team Melt, a Draft Pick) has no game and no
--       season: NULL (20261126021927);
--   (e) the season is ESPN's number for that date (NBA by the year it ENDS, NFL by the year it starts);
--   (f) the box-score fallback answers only when the night before is empty;
--   (g) a collection without ESPN stats, or a player without an ESPN id, is NULL;
--   (h) a TEAM Moment (its subject is one of its own two teams) gets that team's result, read from the
--       lines whose opponent is the OTHER team on that date — never the other side's line (an Eagles
--       Moment never shows the Chiefs' result), with or without a player_id; no line, or a placeholder
--       opponent, is NULL (20261126161848, 20261126162015).
--
-- The function DDL below is VERBATIM from
-- supabase/migrations/20261126025114_audit_20261125_moment_game_context_reissue_for_pins.sql (moment_gamelog_season)
-- and supabase/migrations/20261126162015_audit_20261126_moment_game_context_team_moments_without_player_id.sql (get_moment_game_context);
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, player_id uuid, game_date date, home_team text, away_team text,
  description text, player_name text
);
CREATE TABLE public.player_identities (
  player_id uuid, league text, espn_league text, espn_id text, stats_refreshed_at timestamptz
);
CREATE TABLE public.player_season_stats (
  league text, espn_id text, season integer, season_type integer, category text, display_name text,
  team_slug text, is_total boolean, labels text[], names text[], "values" text[]
);
CREATE TABLE public.player_gamelog_lines (
  espn_league text, espn_id text, event_id text, season integer, season_type_name text, game_at timestamptz,
  game_date date, game_date_utc date, at_vs text, opponent_abbr text, opponent_name text, score text,
  result text, names text[], labels text[], "values" text[]
);
CREATE TABLE public.player_game_stats (
  league text, espn_id text, event_id text, game_date date, is_home boolean, opponent_abbr text,
  did_not_play boolean, stats jsonb
);

\set TS '95f28a17-224a-4025-96ad-adf8a4c63bfd'
\set AD 'dee28451-5d62-409e-a1ad-a83f763ac070'
\set PIN 'aaaaaaaa-0000-0000-0000-000000000001'
INSERT INTO public.collections VALUES (:'TS'::uuid, 'nba_top_shot'), (:'AD'::uuid, 'nfl_all_day'), (:'PIN'::uuid, 'disney_pinnacle');

-- players: Giannis, Lillard, an NFL QB, a Top Shot player with no ESPN id, Brunson
INSERT INTO public.player_identities VALUES
  ('10000000-0000-0000-0000-000000000001', 'nba', 'nba', '3032977', now()),
  ('10000000-0000-0000-0000-000000000002', 'nba', 'nba', '6606', now()),
  ('10000000-0000-0000-0000-000000000003', 'nfl', 'nfl', '3139477', now()),
  ('10000000-0000-0000-0000-000000000004', 'nba', 'nba', NULL, now()),
  ('10000000-0000-0000-0000-000000000005', 'nba', 'nba', '3934672', now());

INSERT INTO public.editions VALUES
  -- (b) Giannis 2026-11-14, a back-to-back; the description names Detroit (the US-date game)
  ('20000000-0000-0000-0000-000000000001', :'TS'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-14', NULL, NULL,
   'Giannis Antetokounmpo was named the East''s Player of the Week, and his passing set the tone early against Detroit … the Pistons defense'),
  -- (a) Lillard 2024-12-11: one game (12-10 ET vs ORL, UTC 12-11)
  ('20000000-0000-0000-0000-000000000002', :'TS'::uuid, '10000000-0000-0000-0000-000000000002', '2024-12-11', NULL, NULL, NULL),
  -- (a) Lillard 2025-01-05: his nearest game is 01-04, neither reading of 01-05
  ('20000000-0000-0000-0000-000000000003', :'TS'::uuid, '10000000-0000-0000-0000-000000000002', '2025-01-05', NULL, NULL, NULL),
  -- (d) All Day Player Melt (no teams) and a real All Day game
  ('20000000-0000-0000-0000-000000000004', :'AD'::uuid, '10000000-0000-0000-0000-000000000003', '2023-09-10', NULL, NULL, NULL),
  ('20000000-0000-0000-0000-000000000005', :'AD'::uuid, '10000000-0000-0000-0000-000000000003', '2025-02-09', 'Philadelphia Eagles', 'Kansas City Chiefs', NULL),
  -- (f) Giannis, recent Moments only the box-score lane knows
  ('20000000-0000-0000-0000-000000000006', :'TS'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-20', NULL, NULL, NULL),
  ('20000000-0000-0000-0000-000000000007', :'TS'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-22', NULL, NULL, NULL),
  ('20000000-0000-0000-0000-000000000010', :'TS'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-21', NULL, NULL, NULL),
  -- (g) Pinnacle, and a Top Shot player with no ESPN id
  ('20000000-0000-0000-0000-000000000008', :'PIN'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-14', NULL, NULL, NULL),
  ('20000000-0000-0000-0000-000000000009', :'TS'::uuid, '10000000-0000-0000-0000-000000000004', '2026-11-14', NULL, NULL, NULL),
  -- (b) Brunson 2025-12-19 back-to-back, recorded Pacers vs Knicks: the UTC-date IND game, not the US-date PHI game
  ('20000000-0000-0000-0000-000000000011', :'TS'::uuid, '10000000-0000-0000-0000-000000000005', '2025-12-19', 'Indiana Pacers', 'New York Knicks', NULL),
  -- (b) Brunson 2026-02-22 back-to-back with no teams and no description: no game line
  ('20000000-0000-0000-0000-000000000012', :'TS'::uuid, '10000000-0000-0000-0000-000000000005', '2026-02-22', NULL, NULL, 'A step-back three from the wing.'),
  -- (c) Brunson 2026-01-10: one game on the date, but the edition records a different opponent
  ('20000000-0000-0000-0000-000000000013', :'TS'::uuid, '10000000-0000-0000-0000-000000000005', '2026-01-10', 'New York Knicks', 'Boston Celtics', NULL),
  -- (c) and one where "LA Clippers" (ESPN) is recorded as "Los Angeles Clippers"
  ('20000000-0000-0000-0000-000000000014', :'TS'::uuid, '10000000-0000-0000-0000-000000000005', '2026-01-12', 'Los Angeles Clippers', 'New York Knicks', NULL),
  -- (c) "N/A" is not a team: it must not veto the one game on the date; a trailing space is not a name
  ('20000000-0000-0000-0000-000000000015', :'TS'::uuid, '10000000-0000-0000-0000-000000000005', '2026-01-10', 'New York Knicks', 'N/A', NULL),
  ('20000000-0000-0000-0000-000000000016', :'TS'::uuid, '10000000-0000-0000-0000-000000000005', '2026-01-10', 'Miami Heat ', 'New York Knicks', NULL),
  -- (b) Brunson 2026-02-22 again, the description naming the opponent's CITY ("against Houston")
  ('20000000-0000-0000-0000-000000000017', :'TS'::uuid, '10000000-0000-0000-0000-000000000005', '2026-02-22', NULL, NULL, 'Jalen Brunson pulls up against Houston for the go-ahead three.');

-- (h) TEAM Moments: the subject is one of the edition's own teams; no player identity exists for them
INSERT INTO public.editions VALUES
  -- the Chiefs' Super Bowl: read from a Chiefs player's line (opponent Philadelphia Eagles) → L 22-40
  ('20000000-0000-0000-0000-000000000018', :'AD'::uuid, '10000000-0000-0000-0000-0000000000a1', '2025-02-09', 'Philadelphia Eagles', 'Kansas City Chiefs', NULL, 'Kansas City Chiefs'),
  -- the Eagles' side of the same game: the only stored line is a CHIEFS player's (opponent = the Eagles),
  -- which is not the Eagles' result — nothing
  ('20000000-0000-0000-0000-000000000019', :'AD'::uuid, '10000000-0000-0000-0000-0000000000a2', '2025-02-09', 'Philadelphia Eagles', 'Kansas City Chiefs', NULL, 'Philadelphia Eagles'),
  -- a Top Shot team Moment dated by the UTC date: the Bucks' 12-10 ET game vs Orlando → W 114-109
  -- (Top Shot's team editions carry NO player_id — 139 in production, 2026-11-26)
  ('20000000-0000-0000-0000-000000000020', :'TS'::uuid, NULL, '2024-12-11', 'Milwaukee Bucks', 'Orlando Magic', NULL, 'Milwaukee Bucks'),
  -- a placeholder opponent is not a game
  ('20000000-0000-0000-0000-000000000021', :'TS'::uuid, '10000000-0000-0000-0000-0000000000a3', '2024-12-11', 'Milwaukee Bucks', 'N/A', NULL, 'Milwaukee Bucks');

INSERT INTO public.player_season_stats VALUES
  ('nba', '3032977', 2027, 2, 'averages', 'Averages', 'miami-heat', false, '{PTS}', '{avgPoints}', '{28.2}'),
  ('nba', '6606',    2025, 2, 'averages', 'Averages', 'milwaukee-bucks', false, '{PTS}', '{avgPoints}', '{24.9}'),
  ('nba', '6606',    2024, 2, 'averages', 'Averages', 'portland-trail-blazers', false, '{PTS}', '{avgPoints}', '{32.2}'),
  ('nba', '3934672', 2026, 2, 'averages', 'Averages', 'new-york-knicks', false, '{PTS}', '{avgPoints}', '{27.1}'),
  ('nfl', '3139477', 2024, 2, 'passing', 'Passing', 'kansas-city-chiefs', false, '{YDS}', '{passingYards}', '{3928}');

INSERT INTO public.player_gamelog_lines VALUES
  -- Giannis back-to-back: 11-13 8 PM ET @ CLE (UTC date 11-14), 11-14 vs DET (US date 11-14)
  ('nba', '3032977', 'cle', 2027, '2026-27 Regular Season', '2026-11-14 01:00+00', '2026-11-13', '2026-11-14', '@', 'CLE', 'Cleveland Cavaliers', '133-121', 'W', '{points}', '{PTS}', '{40}'),
  ('nba', '3032977', 'det', 2027, '2026-27 Regular Season', '2026-11-15 01:00+00', '2026-11-14', '2026-11-15', 'vs', 'DET', 'Detroit Pistons', '137-117', 'W', '{points}', '{PTS}', '{34}'),
  -- Lillard 12-10 ET vs ORL (UTC 12-11), and 01-04
  ('nba', '6606', 'orl', 2025, '2024-25 Regular Season', '2024-12-11 00:00+00', '2024-12-10', '2024-12-11', 'vs', 'ORL', 'Orlando Magic', '114-109', 'W', '{points}', '{PTS}', '{28}'),
  ('nba', '6606', 'jan4', 2025, '2024-25 Regular Season', '2025-01-04 20:00+00', '2025-01-04', '2025-01-04', '@', 'BKN', 'Brooklyn Nets', '100-95', 'W', '{points}', '{PTS}', '{19}'),
  -- the QB: Week 1 2023 (where the melt is dated) and the Super Bowl
  ('nfl', '3139477', 'wk1b', 2023, '2023 Regular Season', '2023-09-10 17:00+00', '2023-09-10', '2023-09-10', 'vs', 'X', 'X', '1-0', 'W', '{passingYards}', '{YDS}', '{1}'),
  ('nfl', '3139477', 'sb', 2024, '2024 Postseason', '2025-02-09 23:30+00', '2025-02-09', '2025-02-09', 'vs', 'PHI', 'Philadelphia Eagles', '22-40', 'L', '{passingYards}', '{YDS}', '{257}'),
  -- Brunson 12-18 ET @ IND (UTC 12-19) and 12-19 vs PHI (US 12-19)
  ('nba', '3934672', 'ind', 2026, '2025-26 Regular Season', '2025-12-19 00:30+00', '2025-12-18', '2025-12-19', '@', 'IND', 'Indiana Pacers', '110-104', 'W', '{points}', '{PTS}', '{33}'),
  ('nba', '3934672', 'phi', 2026, '2025-26 Regular Season', '2025-12-20 00:30+00', '2025-12-19', '2025-12-20', 'vs', 'PHI', 'Philadelphia 76ers', '99-101', 'L', '{points}', '{PTS}', '{21}'),
  -- Brunson 02-21 ET vs HOU (UTC 02-22) and 02-22 @ CHI (US 02-22)
  ('nba', '3934672', 'hou', 2026, '2025-26 Regular Season', '2026-02-22 00:30+00', '2026-02-21', '2026-02-22', 'vs', 'HOU', 'Houston Rockets', '120-111', 'W', '{points}', '{PTS}', '{30}'),
  ('nba', '3934672', 'chi', 2026, '2025-26 Regular Season', '2026-02-23 01:00+00', '2026-02-22', '2026-02-23', '@', 'CHI', 'Chicago Bulls', '105-112', 'L', '{points}', '{PTS}', '{18}'),
  -- Brunson 01-10 @ MIA (one game; the edition says Celtics) and 01-12 vs LAC (one game; recorded "Los Angeles Clippers")
  ('nba', '3934672', 'mia', 2026, '2025-26 Regular Season', '2026-01-10 20:00+00', '2026-01-10', '2026-01-10', '@', 'MIA', 'Miami Heat', '100-90', 'W', '{points}', '{PTS}', '{25}'),
  ('nba', '3934672', 'lac', 2026, '2025-26 Regular Season', '2026-01-12 20:00+00', '2026-01-12', '2026-01-12', 'vs', 'LAC', 'LA Clippers', '118-115', 'W', '{points}', '{PTS}', '{29}');

INSERT INTO public.player_game_stats VALUES
  ('nba', '3032977', 'box20', '2026-11-20', true,  'BOS', false, '{"points":"31"}'),
  ('nba', '3032977', 'box21', '2026-11-21', false, 'NY',  false, '{"points":"22"}');

-- >>> BEGIN verbatim (keep byte-identical to the migration) >>>
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
-- <<< END verbatim <<<

-- >>> BEGIN verbatim (keep byte-identical to the migration) >>>
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
begin
  select e.player_id, e.player_name, e.game_date, c.slug, e.home_team, e.away_team, e.description into v_e
    from public.editions e
    join public.collections c on c.id = e.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day')
   where e.id = p_edition_id;
  if v_e.game_date is null then
    return null;
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
-- <<< END verbatim <<<

-- (a) one game on the date, either reading
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000002')->'game'->>'opponent_abbr', 'ORL',
  '(a) Lillard''s 12-11 Moment is the 12-10 ET ORL game (its UTC date)');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000003')->'game' = 'null'::jsonb,
  '(a) a game on neither reading of the date is not this Moment''s game');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000003')->>'season', '2025',
  '(e) a January 2025 NBA game is the 2024-25 season, numbered 2025');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000003')->'season_rows'->0->'values'->>0, '24.9',
  '(e) the 2025 season''s line, not 2024''s');
-- (b) back-to-backs
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000001')->'game'->>'opponent_abbr', 'DET',
  '(b) Giannis 11-14: the description names Detroit, the US-date game');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000011')->'game'->>'opponent_abbr', 'IND',
  '(b) Brunson 12-19, recorded Pacers vs Knicks: the UTC-date IND game, not the US-date PHI game');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000012')->'game' = 'null'::jsonb,
  '(b) a back-to-back with no evidence either way gets no game line');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000012')->>'season', '2026',
  '(b) ... and still its season');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000017')->'game'->>'opponent_abbr', 'HOU',
  '(b) a description naming the opponent''s city settles a back-to-back');
-- (c) recorded teams veto a single candidate; nicknames match across spellings
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000013')->'game' = 'null'::jsonb,
  '(c) an edition recorded vs Boston never gets the Miami game on its date');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000014')->'game'->>'opponent_abbr', 'LAC',
  '(c) "LA Clippers" is the recorded "Los Angeles Clippers"');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000015')->'game'->>'opponent_abbr', 'MIA',
  '(c) an "N/A" side is no record of the teams: the one game on the date stands');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000016')->'game'->>'opponent_abbr', 'MIA',
  '(c) "Miami Heat " (trailing space) is the Heat');
-- (d) an All Day play with no teams is not a game: nothing, not the Week 1 game on its date
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000004') IS NULL,
  '(d) a Player Melt dated to the 2023 opener has no game and no season');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000005')->'game'->>'opponent_abbr', 'PHI',
  '(d) the Super Bowl Moment is the Super Bowl');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000005')->>'season', '2024',
  '(e) an NFL February game belongs to the season that started the year before');
-- (f) the box-score lane: exact date, and only with the night before empty
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000006')->'game'->>'source', 'box',
  '(f) a recent game only the box-score lane knows');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000010')->'game' = 'null'::jsonb,
  '(f) 11-21 has a box row but so does 11-20 — a UTC-dated Moment for 11-20 reads as 11-21: no line');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000007')->'game' = 'null'::jsonb,
  '(f) the box-score lane does not lend the 11-21 game to an 11-22 Moment');
-- (g) out of scope
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000008') IS NULL, '(g) Pinnacle has no ESPN stats');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000018')->'game'->>'source', 'team',
  '(h) a team Moment gets the team result');
SELECT _assert_eq((public.get_moment_game_context('20000000-0000-0000-0000-000000000018')->'game'->>'result') || ' ' || (public.get_moment_game_context('20000000-0000-0000-0000-000000000018')->'game'->>'score'), 'L 22-40',
  '(h) the Chiefs team Moment reads the Chiefs'' result from a Chiefs player''s line');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000018')->>'season', '2024',
  '(h) a team Moment carries the season number');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000019') IS NULL,
  '(h) the Eagles team Moment never borrows the Chiefs'' line');
SELECT _assert_eq((public.get_moment_game_context('20000000-0000-0000-0000-000000000020')->'game'->>'result') || ' ' || (public.get_moment_game_context('20000000-0000-0000-0000-000000000020')->'game'->>'opponent_abbr'), 'W ORL',
  '(h) a Top Shot team Moment dated by the UTC date finds its game');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000021') IS NULL,
  '(h) N/A is not an opponent');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000009') IS NULL, '(g) no ESPN id, no stats');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-0000000000ff') IS NULL, '(g) an unknown edition');

ROLLBACK;
