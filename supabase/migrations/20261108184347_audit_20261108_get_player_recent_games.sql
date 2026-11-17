-- audit_20261108_get_player_recent_games
-- One person's most recent games beside that collection's player market cap, for the concierge's
-- get_player_games tool. Reads the same objects as player_game_market_moves (player_game_stats,
-- espn_leagues, player_identities / golazos_espn_crosswalk / panini_espn_crosswalk,
-- market_cap_daily) but filters to ONE player first, so it never aggregates the whole table.
--
-- p_slugs: the slugs that may name the person in this collection — the resolver's page slug and
-- the slug of the person's label (a trailing "Jr." page slug keeps its dash; the market-cap key
-- does not). Returns jsonb:
--   { linked: <distinct ESPN ids>, espn_ids, games: [...], season_avg_fp, games_in_season,
--     first_game_date, mcap_now }
--   linked = 0 → no crosswalk for this person (the tool says so; never "didn't play").
--   linked > 1 → two ESPN people share the slugs (the tool asks which; never merges).
-- Each game: date, league, opponent, is_home, did_not_play, minutes, fantasy_points, stats
-- (box group → ESPN key → value), mcap_before (d-1), mcap_after (d+1), held_before, held_after.
--
-- Revert: drop function public.get_player_recent_games(text, text[], int);

create or replace function public.get_player_recent_games(p_collection_slug text, p_slugs text[], p_limit int default 5)
returns jsonb language sql stable
set search_path = pg_catalog, public
as $$
  with ids as (
    select distinct pi.espn_id,
           case pi.league when 'nfl' then 'football' when 'mlb' then 'baseball' else 'basketball' end as sport
      from public.player_identities pi
      join public.collections c on c.id = pi.collection_id
     where c.slug = p_collection_slug and pi.espn_id is not null and pi.name_slug = any (p_slugs)
    union
    select x.espn_id, 'soccer'
      from public.golazos_espn_crosswalk x
     where p_collection_slug = 'laliga_golazos' and x.espn_id is not null and x.name_slug = any (p_slugs)
    union
    select p.espn_id, p.sport
      from public.panini_espn_crosswalk p
     where p_collection_slug = 'panini_blockchain' and p.espn_id is not null and p.name_slug = any (p_slugs)
  ), g as (
    select s.league, s.event_id, s.game_date, s.season,
           max(s.opponent_abbr) as opponent, bool_or(s.is_home) as is_home,
           bool_and(s.did_not_play) as did_not_play, max(s.minutes) as minutes,
           sum(s.fantasy_points) as fantasy_points,
           jsonb_object_agg(case when s.category = '' then 'line' else s.category end, s.stats)
             filter (where s.stats <> '{}'::jsonb) as stats
      from public.player_game_stats s
      join public.espn_leagues l on l.league = s.league
      join ids on ids.espn_id = s.espn_id and ids.sport = l.sport
     where (select count(distinct espn_id) from ids) = 1
     group by s.league, s.event_id, s.game_date, s.season
  ), latest_season as (
    select league, season from g order by game_date desc limit 1
  ), mc as (
    select m.snapshot_date, m.mcap_usd, m.collector_held
      from public.market_cap_daily m
     where m.collection_slug = p_collection_slug and m.grain = 'player' and m.group_key = any (p_slugs)
  ), recent as (
    select g.* from g order by g.game_date desc, g.event_id limit greatest(1, least(coalesce(p_limit, 5), 15))
  )
  select jsonb_build_object(
    'linked', (select count(distinct espn_id) from ids),
    'espn_ids', (select coalesce(jsonb_agg(distinct espn_id), '[]'::jsonb) from ids),
    'season_avg_fp', (select round(avg(g.fantasy_points)::numeric, 2) from g join latest_season ls using (league, season)
                       where not g.did_not_play),
    'games_in_season', (select count(*) from g join latest_season ls using (league, season) where not g.did_not_play),
    'first_game_date', (select min(game_date) from g),
    'mcap_now', (select mcap_usd from mc order by snapshot_date desc limit 1),
    'games', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', r.game_date, 'league', r.league, 'opponent', r.opponent, 'is_home', r.is_home,
               'did_not_play', r.did_not_play, 'minutes', r.minutes, 'fantasy_points', r.fantasy_points,
               'stats', r.stats,
               'mcap_before', (select mcap_usd from mc where snapshot_date = r.game_date - 1 limit 1),
               'mcap_after', (select mcap_usd from mc where snapshot_date = r.game_date + 1 limit 1),
               'held_before', (select collector_held from mc where snapshot_date = r.game_date - 1 limit 1),
               'held_after', (select collector_held from mc where snapshot_date = r.game_date + 1 limit 1))
             order by r.game_date desc, r.event_id)
        from recent r), '[]'::jsonb))
$$;
-- anon-exec: revoked (get_player_recent_games) — new function; revoked from PUBLIC, anon, authenticated below; the concierge reads it with the service role.
revoke execute on function public.get_player_recent_games(text, text[], int) from public, anon, authenticated;
grant execute on function public.get_player_recent_games(text, text[], int) to postgres, service_role;