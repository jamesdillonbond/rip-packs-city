-- DB invariant: get_moment_game_context picks THE game a Moment is from, or none (2026-11-25).
--
-- The back of the interactive Moment slab shows the player's line from the Moment's game and that
-- season's averages. Rules pinned here, each measured on production before it was written:
--   (a) the Moment's date must match the game EXACTLY. Top Shot and All Day date a Moment by the US
--       game date (NBA 40 US-only vs 0 UTC-only; All Day 69 / 69). On a back-to-back the UTC date of
--       the previous night's late game equals the Moment's date — Giannis 2026-11-14 got the 11-13
--       Cleveland game before 20261126020836 — so the US date wins;
--   (b) a UTC-dated Moment still resolves (Lillard NBA Cup: Moment 12-11, game 12-10 ET);
--   (c) no nearest-day fallback — a game a day away is a different game: no line, season still shown;
--   (d) an All Day play without both teams (a Player/Team Melt, a Draft Pick) has no game and no
--       season: NULL (20261126021927);
--   (e) the season is ESPN's number for that date (NBA by the year it ENDS, NFL by the year it starts);
--   (f) the box-score fallback matches the exact date too;
--   (g) a collection without ESPN stats, or a player without an ESPN id, is NULL.
--
-- The function DDL below is VERBATIM from
-- supabase/migrations/20261126025114_audit_20261125_moment_game_context_reissue_for_pins.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, player_id uuid, game_date date, home_team text, away_team text
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

-- players: Giannis, Lillard, an NFL QB, and a Top Shot player with no ESPN id
INSERT INTO public.player_identities VALUES
  ('10000000-0000-0000-0000-000000000001', 'nba', 'nba', '3032977', now()),
  ('10000000-0000-0000-0000-000000000002', 'nba', 'nba', '6606', now()),
  ('10000000-0000-0000-0000-000000000003', 'nfl', 'nfl', '3139477', now()),
  ('10000000-0000-0000-0000-000000000004', 'nba', 'nba', NULL, now());

INSERT INTO public.editions VALUES
  -- (a) Giannis, Moment dated 2026-11-14 (US date of the DET game)
  ('20000000-0000-0000-0000-000000000001', :'TS'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-14', NULL, NULL),
  -- (b) Lillard, Moment dated 2024-12-11 (UTC date of the 12-10 ET ORL game)
  ('20000000-0000-0000-0000-000000000002', :'TS'::uuid, '10000000-0000-0000-0000-000000000002', '2024-12-11', NULL, NULL),
  -- (c) Lillard, Moment dated 2025-01-05: his nearest game is 01-04
  ('20000000-0000-0000-0000-000000000003', :'TS'::uuid, '10000000-0000-0000-0000-000000000002', '2025-01-05', NULL, NULL),
  -- (d) All Day Player Melt (no teams) and (d') a real All Day game
  ('20000000-0000-0000-0000-000000000004', :'AD'::uuid, '10000000-0000-0000-0000-000000000003', '2023-09-10', NULL, NULL),
  ('20000000-0000-0000-0000-000000000005', :'AD'::uuid, '10000000-0000-0000-0000-000000000003', '2025-02-09', 'Philadelphia Eagles', 'Kansas City Chiefs'),
  -- (f) Giannis, a later Moment only the box-score lane knows; and one a day off it
  ('20000000-0000-0000-0000-000000000006', :'TS'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-20', NULL, NULL),
  ('20000000-0000-0000-0000-000000000007', :'TS'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-22', NULL, NULL),
  -- (g) Pinnacle, and a Top Shot player with no ESPN id
  ('20000000-0000-0000-0000-000000000008', :'PIN'::uuid, '10000000-0000-0000-0000-000000000001', '2026-11-14', NULL, NULL),
  ('20000000-0000-0000-0000-000000000009', :'TS'::uuid, '10000000-0000-0000-0000-000000000004', '2026-11-14', NULL, NULL);

INSERT INTO public.player_season_stats VALUES
  ('nba', '3032977', 2027, 2, 'averages', 'Averages', 'miami-heat', false, '{PTS}', '{avgPoints}', '{28.2}'),
  ('nba', '6606',    2025, 2, 'averages', 'Averages', 'milwaukee-bucks', false, '{PTS}', '{avgPoints}', '{24.9}'),
  ('nba', '6606',    2024, 2, 'averages', 'Averages', 'portland-trail-blazers', false, '{PTS}', '{avgPoints}', '{32.2}'),
  ('nfl', '3139477', 2024, 2, 'passing', 'Passing', 'kansas-city-chiefs', false, '{YDS}', '{passingYards}', '{3928}');

INSERT INTO public.player_gamelog_lines VALUES
  -- Giannis back-to-back: 11-13 8 PM ET @ CLE (UTC date 11-14), 11-14 vs DET (US date 11-14)
  ('nba', '3032977', 'cle', 2027, '2026-27 Regular Season', '2026-11-14 01:00+00', '2026-11-13', '2026-11-14', '@', 'CLE', 'Cleveland Cavaliers', '133-121', 'W', '{points}', '{PTS}', '{40}'),
  ('nba', '3032977', 'det', 2027, '2026-27 Regular Season', '2026-11-15 01:00+00', '2026-11-14', '2026-11-15', 'vs', 'DET', 'Detroit Pistons', '137-117', 'W', '{points}', '{PTS}', '{34}'),
  -- Lillard 12-10 ET vs ORL (UTC 12-11), and 01-04
  ('nba', '6606', 'orl', 2025, '2024-25 Regular Season', '2024-12-11 00:00+00', '2024-12-10', '2024-12-11', 'vs', 'ORL', 'Orlando Magic', '114-109', 'W', '{points}', '{PTS}', '{28}'),
  ('nba', '6606', 'jan4', 2025, '2024-25 Regular Season', '2025-01-04 20:00+00', '2025-01-04', '2025-01-04', '@', 'BKN', 'Brooklyn Nets', '100-95', 'W', '{points}', '{PTS}', '{19}'),
  -- the QB: Week 1 2023 (where the melt is dated) and the Super Bowl
  ('nfl', '3139477', 'wk1', 2023, '2023 Regular Season', '2023-09-08 00:20+00', '2023-09-07', '2023-09-08', 'vs', 'DET', 'Detroit Lions', '20-21', 'L', '{passingYards}', '{YDS}', '{226}'),
  ('nfl', '3139477', 'wk1b', 2023, '2023 Regular Season', '2023-09-10 17:00+00', '2023-09-10', '2023-09-10', 'vs', 'X', 'X', '1-0', 'W', '{passingYards}', '{YDS}', '{1}'),
  ('nfl', '3139477', 'sb', 2024, '2024 Postseason', '2025-02-09 23:30+00', '2025-02-09', '2025-02-09', 'vs', 'PHI', 'Philadelphia Eagles', '22-40', 'L', '{passingYards}', '{YDS}', '{257}');

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
-- <<< END verbatim <<<

-- (a) the US date wins a back-to-back
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000001')->'game'->>'opponent_abbr', 'DET',
  '(a) a Moment dated 2026-11-14 is the 11-14 DET game, not the 11-13 CLE game whose UTC date is 11-14');
-- (b) a UTC-dated Moment still resolves
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000002')->'game'->>'opponent_abbr', 'ORL',
  '(b) Lillard''s 12-11 Moment is the 12-10 ET ORL game');
-- (c) no nearest-day fallback; the season still shows
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000003')->'game' = 'null'::jsonb,
  '(c) a game a day away is not this Moment''s game');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000003')->>'season', '2025',
  '(c, e) the season still resolves: a January 2025 NBA game is the 2024-25 season, numbered 2025');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000003')->'season_rows'->0->'values'->>0, '24.9',
  '(e) the 2025 season''s line, not 2024''s');
-- (d) an All Day play with no teams is not a game: nothing, not the Week 1 game on its date
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000004') IS NULL,
  '(d) a Player Melt dated to the 2023 opener has no game and no season');
-- (d') a real All Day game resolves, in the season it STARTED (a February Super Bowl is 2024)
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000005')->'game'->>'opponent_abbr', 'PHI',
  '(d'') the Super Bowl Moment is the Super Bowl');
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000005')->>'season', '2024',
  '(e) an NFL February game belongs to the season that started the year before');
-- (f) the box-score lane: exact date only
SELECT _assert_eq(public.get_moment_game_context('20000000-0000-0000-0000-000000000006')->'game'->>'source', 'box',
  '(f) a recent game only the box-score lane knows');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000007')->'game' = 'null'::jsonb,
  '(f) the box-score lane does not lend the 11-21 game to an 11-22 Moment');
-- (g) out of scope
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000008') IS NULL, '(g) Pinnacle has no ESPN stats');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-000000000009') IS NULL, '(g) no ESPN id, no stats');
SELECT _assert(public.get_moment_game_context('20000000-0000-0000-0000-0000000000ff') IS NULL, '(g) an unknown edition');

ROLLBACK;
