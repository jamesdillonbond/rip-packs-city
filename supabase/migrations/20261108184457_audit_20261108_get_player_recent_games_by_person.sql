-- audit_20261108_get_player_recent_games_by_person
-- Replaces get_player_recent_games(text, text[], int) (20261108184347, no caller yet) with a
-- version that keys Top Shot / All Day / Candy on the RESOLVED PERSON (players.id via
-- player_identities.player_id) instead of the name slug. Measured 2026-11-08 ~10:55 AM PT: the
-- All Day slug 'josh-allen' carries two ESPN ids — the Bills QB (linked to the players row) and
-- an unlinked 2012-era Josh Allen — so a slug match refused the QB as ambiguous although the
-- resolver had already named him. Golazos and Panini have no player_id link, so they keep the
-- slug match through their crosswalks. p_player_id NULL keeps the old slug behaviour.
--
-- Revert: drop function public.get_player_recent_games(text, text[], uuid, int); then re-apply
-- 20261108184347.

drop function public.get_player_recent_games(text, text[], int);

create or replace function public.get_player_recent_games(p_collection_slug text, p_slugs text[], p_player_id uuid default null, p_limit int default 5)
returns jsonb language sql stable
set search_path = pg_catalog, public
as $$
  with ids as (
    select distinct pi.espn_id,
           case pi.league when 'nfl' then 'football' when 'mlb' then 'baseball' else 'basketball' end as sport
      from public.player_identities pi
      join public.collections c on c.id = pi.collection_id
     where c.slug = p_collection_slug and pi.espn_id is not null
       and (case when p_player_id is not null then pi.player_id = p_player_id else pi.name_slug = any (p_slugs) end)
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
-- anon-exec: revoked (get_player_recent_games) — new signature; revoked from PUBLIC, anon, authenticated below; the concierge reads it with the service role.
revoke execute on function public.get_player_recent_games(text, text[], uuid, int) from public, anon, authenticated;
grant execute on function public.get_player_recent_games(text, text[], uuid, int) to postgres, service_role;