-- audit_20261108_panini_espn_crosswalk
-- Panini players → ESPN athlete ids, so Panini cards join player_game_market_moves beside
-- Top Shot / All Day / Candy / Golazos. Panini carries no league id (player-identity.md:
-- "across collections there is NO person key"), so this is a NAME match, held to three rules:
--   1. SPORT-SCOPED. A Panini market-cap player key (group_key) gets its sport the way
--      get_player_hub does it: panini_products.last_grid_sport of its editions via the
--      packcard-<set_id>_ prefix ("Womens Basketball" folds into basketball). A slug that spans
--      two sports gets one row per sport.
--   2. EXACTLY ONE PERSON. Candidates are ESPN ids carrying that slug in the same sport, from
--      player_identities (name_slug + the league's display name) and espn_athletes (box-score
--      names). Two ids → 'ambiguous', no espn_id.
--   3. NO FAMILY GUESSING. If the slug with its generational suffix removed reaches MORE than one
--      id (Gary Payton / Gary Payton II, Tim Hardaway / Jr., Robert Griffin III), the row is
--      'family_ambiguous' with no espn_id — Panini drops suffixes often enough that a bare
--      "Gary Payton" card cannot be assigned to either man by name.
-- Measured before apply (2026-11-08 ~10:35 AM PT): basketball 846 of 1,059 keys ($14.15M of
-- $14.45M player mcap), football 1,069 of 1,277 ($7.30M of $7.84M), baseball 41 of 314
-- ($0.98M of $1.23M), soccer 14 of 2,109 (only LaLiga box-score names exist), racing 0.
-- Like golazos_espn_crosswalk this is NOT player_identities: the name writers read that table.
--
-- The view now joins a game to EVERY collection carrying that person in the game's sport
-- (an NBA game yields a Top Shot row AND a Panini row), instead of one collection per league.
--
-- Lane: refresh_panini_espn_crosswalk() daily via pg_cron 'rpc-panini-espn-crosswalk'
-- (41 11 * * * UTC = 3:41 AM PST), pipeline 'panini-espn-crosswalk', watchlist 1,560 / 3,000 min.
--
-- Revert:
--   select cron.unschedule('rpc-panini-espn-crosswalk');
--   delete from public.pipeline_cadence_watchlist where pipeline = 'panini-espn-crosswalk';
--   drop function public.refresh_panini_espn_crosswalk(); drop table public.panini_espn_crosswalk;
--   then re-apply the 20261108181838 body of player_game_market_moves.

create table public.panini_espn_crosswalk (
  name_slug     text not null,       -- market_cap_daily group_key for panini_blockchain
  sport         text not null,       -- basketball | football | baseball | soccer | racing | …
  player_label  text not null,
  espn_id       text,                -- NULL unless exactly one person
  matched_by    text not null,       -- 'sport-unique-name' | 'ambiguous' | 'family_ambiguous'
  candidates    jsonb,
  matched_at    timestamptz not null default now(),
  primary key (name_slug, sport)
);
alter table public.panini_espn_crosswalk enable row level security;
revoke all on public.panini_espn_crosswalk from anon, authenticated;

create or replace function public.refresh_panini_espn_crosswalk()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_out     jsonb;
begin
  with ps as (
    select public.rpc_name_slug(e.player_name) as slug,
           case when pp.last_grid_sport ilike '%basketball%' then 'basketball' else lower(pp.last_grid_sport) end as sport
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.slug = 'panini_blockchain'
      join public.panini_products pp on pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
     where e.external_id like 'packcard-%' and pp.last_grid_sport is not null
     group by 1, 2
  ), g as (
    select m.group_key as name_slug, max(m.group_label) as player_label, ps.sport,
           regexp_replace(m.group_key, '-(jr|sr|ii|iii|iv|v)$', '') as gbase
      from public.market_cap_current m
      join ps on ps.slug = m.group_key
     where m.collection_slug = 'panini_blockchain' and m.grain = 'player' and m.is_primary
     group by m.group_key, ps.sport
  ), cand as (
    select case pi.league when 'nba' then 'basketball' when 'nfl' then 'football' when 'mlb' then 'baseball' end as sport,
           s.slug, regexp_replace(s.slug, '-(jr|sr|ii|iii|iv|v)$', '') as base, pi.espn_id, pi.display_name
      from public.player_identities pi
     cross join lateral (select distinct x from unnest(array[pi.name_slug, public.rpc_name_slug(pi.display_name)]) x
                          where x is not null) s(slug)
     where pi.espn_id is not null
    union
    select case a.league when 'nba' then 'basketball' when 'wnba' then 'basketball' when 'nfl' then 'football'
                         when 'mlb' then 'baseball' when 'laliga' then 'soccer' end,
           s.slug, regexp_replace(s.slug, '-(jr|sr|ii|iii|iv|v)$', ''), a.espn_id, a.display_name
      from public.espn_athletes a
     cross join lateral (select distinct x from unnest(array[public.rpc_name_slug(a.display_name),
                                                             public.rpc_name_slug(a.full_name)]) x
                          where x is not null) s(slug)
  ), m as (
    select g.name_slug, g.sport, g.player_label,
           count(distinct c.espn_id) filter (where c.slug = g.name_slug) as n_exact,
           count(distinct c.espn_id) filter (where c.base = g.gbase) as n_base,
           min(c.espn_id) filter (where c.slug = g.name_slug) as espn_id,
           jsonb_agg(distinct jsonb_build_object('espn_id', c.espn_id, 'name', c.display_name)) as candidates
      from g join cand c on c.sport = g.sport and (c.slug = g.name_slug or c.base = g.gbase)
     group by g.name_slug, g.sport, g.player_label
  ), v as (
    select name_slug, sport, player_label,
           case when n_exact = 1 and n_base <= 1 then espn_id end as espn_id,
           case when n_exact = 1 and n_base <= 1 then 'sport-unique-name'
                when n_exact > 1 then 'ambiguous'
                else 'family_ambiguous' end as matched_by,
           case when n_exact = 1 and n_base <= 1 then null else candidates end as candidates
      from m
     where n_exact >= 1
  ), d as (
    delete from public.panini_espn_crosswalk x
     where not exists (select 1 from v where v.name_slug = x.name_slug and v.sport = x.sport)
    returning 1
  )
  insert into public.panini_espn_crosswalk as x (name_slug, sport, player_label, espn_id, matched_by, candidates, matched_at)
  select name_slug, sport, player_label, espn_id, matched_by, candidates, now() from v
  on conflict (name_slug, sport) do update set
    player_label = excluded.player_label, espn_id = excluded.espn_id, matched_by = excluded.matched_by,
    candidates = excluded.candidates,
    matched_at = case when (x.espn_id, x.matched_by) is distinct from (excluded.espn_id, excluded.matched_by)
                      then now() else x.matched_at end;

  select jsonb_build_object(
           'matched', count(*) filter (where espn_id is not null),
           'ambiguous', count(*) filter (where matched_by = 'ambiguous'),
           'family_ambiguous', count(*) filter (where matched_by = 'family_ambiguous'),
           'by_sport', (select jsonb_object_agg(sport, n) from (select sport, count(*) filter (where espn_id is not null) n
                                                                 from public.panini_espn_crosswalk group by sport) s))
    into v_out from public.panini_espn_crosswalk;

  perform public.log_pipeline_run(
    'panini-espn-crosswalk', v_started, (v_out->>'matched')::int, (v_out->>'matched')::int, 0,
    (v_out->>'matched')::int > 0, case when (v_out->>'matched')::int > 0 then null else 'zero matches' end,
    null, null, null,
    v_out || jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return v_out;
end
$$;
-- anon-exec: revoked (refresh_panini_espn_crosswalk) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.refresh_panini_espn_crosswalk() from public, anon, authenticated;
grant execute on function public.refresh_panini_espn_crosswalk() to postgres, service_role;

create or replace view public.player_game_market_moves with (security_invoker = on) as
with g as (
  select league, espn_id, event_id, game_date, season, season_type,
         max(team_abbr) as team_abbr, max(opponent_abbr) as opponent_abbr, bool_or(is_home) as is_home,
         bool_and(did_not_play) as did_not_play, max(minutes) as minutes,
         sum(fantasy_points) as fantasy_points
    from public.player_game_stats
   group by league, espn_id, event_id, game_date, season, season_type
), gw as (
  select g.*,
         case g.league when 'nfl' then 'football' when 'mlb' then 'baseball' when 'laliga' then 'soccer'
                       else 'basketball' end as sport,
         avg(g.fantasy_points) filter (where not g.did_not_play) over (
           partition by g.league, g.espn_id, g.season order by g.game_date
           rows between unbounded preceding and 1 preceding) as fp_season_avg_before,
         count(*) filter (where not g.did_not_play) over (
           partition by g.league, g.espn_id, g.season order by g.game_date
           rows between unbounded preceding and 1 preceding) as games_before
    from g
), pid as (
  (select distinct on (c.slug, pi.espn_id) c.slug as collection_slug, pi.espn_id, pi.name_slug, pi.display_name,
          case pi.league when 'nfl' then 'football' when 'mlb' then 'baseball' else 'basketball' end as sport
     from public.player_identities pi
     join public.collections c on c.id = pi.collection_id
    where pi.espn_id is not null and pi.name_slug is not null
    order by c.slug, pi.espn_id, pi.matched_at desc nulls last)
  union all
  select 'laliga_golazos'::varchar(50), x.espn_id, x.name_slug, x.player_label, 'soccer'
    from public.golazos_espn_crosswalk x
   where x.espn_id is not null
  union all
  select 'panini_blockchain'::varchar(50), p.espn_id, p.name_slug, p.player_label, p.sport
    from public.panini_espn_crosswalk p
   where p.espn_id is not null
)
select gw.league, gw.espn_id, pid.display_name, pid.name_slug, pid.collection_slug,
       gw.event_id, gw.game_date, gw.season, gw.season_type, gw.team_abbr, gw.opponent_abbr, gw.is_home,
       gw.did_not_play, gw.minutes, gw.fantasy_points, gw.fp_season_avg_before, gw.games_before,
       gw.fantasy_points - gw.fp_season_avg_before as fp_vs_avg,
       m0.mcap_usd as mcap_before, m1.mcap_usd as mcap_d1, m3.mcap_usd as mcap_d3,
       m0.collector_held as held_before, m1.collector_held as held_d1, m3.collector_held as held_d3,
       case when m0.mcap_usd > 0 then m1.mcap_usd / m0.mcap_usd - 1 end as mcap_chg_d1,
       case when m0.mcap_usd > 0 then m3.mcap_usd / m0.mcap_usd - 1 end as mcap_chg_d3
  from gw
  join pid on pid.espn_id = gw.espn_id and pid.sport = gw.sport
  left join public.market_cap_daily m0 on m0.snapshot_date = gw.game_date - 1 and m0.collection_slug = pid.collection_slug
        and m0.grain = 'player' and m0.group_key = pid.name_slug
  left join public.market_cap_daily m1 on m1.snapshot_date = gw.game_date + 1 and m1.collection_slug = pid.collection_slug
        and m1.grain = 'player' and m1.group_key = pid.name_slug
  left join public.market_cap_daily m3 on m3.snapshot_date = gw.game_date + 3 and m3.collection_slug = pid.collection_slug
        and m3.grain = 'player' and m3.group_key = pid.name_slug;
revoke all on public.player_game_market_moves from anon, authenticated;

insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
values ('panini-espn-crosswalk', 1560, 3000, 'info',
  'Added 2026-11-08 (20261108 panini_espn_crosswalk): daily refresh of the Panini → ESPN name crosswalk (sport-scoped, one-person, no family guessing) that feeds player_game_market_moves. pg_cron rpc-panini-espn-crosswalk 41 11 * * * UTC. ok=false only on zero matches.',
  true);

select cron.schedule('rpc-panini-espn-crosswalk', '41 11 * * *', 'select public.refresh_panini_espn_crosswalk()');