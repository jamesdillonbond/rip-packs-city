-- audit_20261108_espn_game_logs
-- Per-game player box scores from ESPN (NBA, WNBA, NFL, MLB) via the database's own
-- pg_net egress (the same host the nba-espn-projections lane uses; ESPN refuses
-- Supabase edge + Vercel egress). One summary request per completed game covers
-- every player in it. Joins to collectible market caps through player_identities.espn_id.
--
-- Lane: espn_gamelog_dispatch() pg_cron */10 (:04) -> espn_gamelog_drain() (:07).
-- Pipeline name 'espn-game-logs'. Backfills each league from 2026-10-01 (market_cap_daily
-- starts 2026-10-03), two scoreboard dates per league per tick.
--
-- Revert:
--   select cron.unschedule('rpc-espn-gamelog-dispatch'); select cron.unschedule('rpc-espn-gamelog-drain');
--   drop view public.player_game_market_moves;
--   drop function public.espn_gamelog_drain(), public.espn_gamelog_dispatch(),
--                 public.espn_game_fantasy(text,text,jsonb), public.espn_num(text);
--   drop table public.player_game_stats, public.espn_game_events, public.espn_gamelog_requests,
--              public.espn_gamelog_backfill_state;
--   delete from public.pipeline_cadence_watchlist where pipeline = 'espn-game-logs';

create table public.espn_game_events (
  league           text not null check (league in ('nba','wnba','nfl','mlb')),
  event_id         text not null,
  event_date       date not null,
  starts_at        timestamptz,
  season           int,
  season_type      int,
  home_abbr        text,
  away_abbr        text,
  state            text,
  completed        boolean not null default false,
  discovered_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  box_requested_at timestamptz,
  box_ingested_at  timestamptz,
  box_attempts     int not null default 0,
  box_last_error   text,
  box_rows         int,
  primary key (league, event_id)
);
create index espn_game_events_box_queue on public.espn_game_events (event_date desc)
  where completed and box_ingested_at is null;

create table public.player_game_stats (
  league         text not null check (league in ('nba','wnba','nfl','mlb')),
  event_id       text not null,
  espn_id        text not null,
  category       text not null default '',
  game_date      date not null,
  season         int,
  season_type    int,
  team_abbr      text,
  opponent_abbr  text,
  is_home        boolean,
  starter        boolean,
  did_not_play   boolean not null default false,
  minutes        numeric,
  stats          jsonb not null default '{}'::jsonb,
  fantasy_points numeric,
  refreshed_at   timestamptz not null default now(),
  primary key (league, event_id, espn_id, category)
);
create index player_game_stats_player on public.player_game_stats (league, espn_id, game_date desc);
create index player_game_stats_date on public.player_game_stats (game_date);

create table public.espn_gamelog_requests (
  request_id    bigint primary key,
  league        text not null,
  kind          text not null check (kind in ('scoreboard','summary')),
  event_id      text,
  slate_date    date,
  dispatched_at timestamptz not null default now(),
  drained_at    timestamptz,
  outcome       jsonb
);
create index espn_gamelog_requests_open on public.espn_gamelog_requests (dispatched_at) where drained_at is null;

create table public.espn_gamelog_backfill_state (
  league      text primary key,
  cursor_date date not null,
  floor_date  date not null,
  done        boolean not null default false,
  updated_at  timestamptz not null default now()
);
insert into public.espn_gamelog_backfill_state (league, cursor_date, floor_date)
select l, ((now() at time zone 'America/Los_Angeles')::date - 2), date '2026-10-01'
  from unnest(array['nba','wnba','nfl','mlb']) l;

alter table public.espn_game_events            enable row level security;
alter table public.player_game_stats           enable row level security;
alter table public.espn_gamelog_requests       enable row level security;
alter table public.espn_gamelog_backfill_state enable row level security;
revoke all on public.espn_game_events, public.player_game_stats, public.espn_gamelog_requests,
              public.espn_gamelog_backfill_state from anon, authenticated;

create or replace function public.espn_num(p text)
returns numeric language sql immutable parallel safe
set search_path = pg_catalog
as $$
  select case
           when t ~ '^[+-]?[0-9]+(\.[0-9]+)?$' then t::numeric
           when t ~ '^[0-9]+(\.[0-9]+)?[-/][0-9]' then split_part(split_part(t, '/', 1), '-', 1)::numeric
         end
    from (select replace(trim(coalesce(p, '')), ',', '') as t) x
$$;
-- anon-exec: revoked (espn_num) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_num(text) from public, anon, authenticated;
grant execute on function public.espn_num(text) to postgres, service_role;

create or replace function public.espn_game_fantasy(p_league text, p_category text, s jsonb)
returns numeric language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  select case
    when p_league in ('nba','wnba') then
        coalesce(public.espn_num(s->>'points'),0)
      + 0.5  * coalesce(public.espn_num(s->>'threePointFieldGoalsMade-threePointFieldGoalsAttempted'),0)
      + 1.25 * coalesce(public.espn_num(s->>'rebounds'),0)
      + 1.5  * coalesce(public.espn_num(s->>'assists'),0)
      + 2    * coalesce(public.espn_num(s->>'steals'),0)
      + 2    * coalesce(public.espn_num(s->>'blocks'),0)
      - 0.5  * coalesce(public.espn_num(s->>'turnovers'),0)
    when p_league = 'nfl' then case p_category
      when 'passing'     then 0.04 * coalesce(public.espn_num(s->>'passingYards'),0)
                            + 4 * coalesce(public.espn_num(s->>'passingTouchdowns'),0)
                            - 2 * coalesce(public.espn_num(s->>'interceptions'),0)
      when 'rushing'     then 0.1 * coalesce(public.espn_num(s->>'rushingYards'),0)
                            + 6 * coalesce(public.espn_num(s->>'rushingTouchdowns'),0)
      when 'receiving'   then 0.5 * coalesce(public.espn_num(s->>'receptions'),0)
                            + 0.1 * coalesce(public.espn_num(s->>'receivingYards'),0)
                            + 6 * coalesce(public.espn_num(s->>'receivingTouchdowns'),0)
      when 'fumbles'     then -2 * coalesce(public.espn_num(s->>'fumblesLost'),0)
      when 'kickReturns' then 6 * coalesce(public.espn_num(s->>'kickReturnTouchdowns'),0)
      when 'puntReturns' then 6 * coalesce(public.espn_num(s->>'puntReturnTouchdowns'),0)
      else 0 end
  end
$$;
-- anon-exec: revoked (espn_game_fantasy) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_game_fantasy(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.espn_game_fantasy(text, text, jsonb) to postgres, service_role;

create or replace function public.espn_gamelog_dispatch()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_min   int  := extract(minute from now())::int;
  v_path  jsonb := '{"nba":"basketball/nba","wnba":"basketball/wnba","nfl":"football/nfl","mlb":"baseball/mlb"}';
  v_req   bigint;
  v_sb    int := 0;
  v_box   int := 0;
  l       text;
  d       date;
  b       record;
  e       record;
begin
  if exists (select 1 from public.espn_gamelog_requests
              where drained_at is null and dispatched_at > now() - interval '10 minutes') then
    return jsonb_build_object('skipped', 'in_flight');
  end if;

  if v_min < 10 or (v_min >= 30 and v_min < 40) then
    foreach l in array array['nba','wnba','nfl','mlb'] loop
      foreach d in array array[v_today - 1, v_today] loop
        v_req := net.http_get(
          url := 'https://site.api.espn.com/apis/site/v2/sports/' || (v_path->>l)
                 || '/scoreboard?dates=' || to_char(d, 'YYYYMMDD') || '&limit=100',
          timeout_milliseconds := 20000);
        insert into public.espn_gamelog_requests (request_id, league, kind, slate_date)
        values (v_req, l, 'scoreboard', d);
        v_sb := v_sb + 1;
      end loop;
    end loop;
  end if;

  for b in select * from public.espn_gamelog_backfill_state where not done order by league loop
    foreach d in array array[b.cursor_date, b.cursor_date - 1] loop
      exit when d < b.floor_date;
      v_req := net.http_get(
        url := 'https://site.api.espn.com/apis/site/v2/sports/' || (v_path->>b.league)
               || '/scoreboard?dates=' || to_char(d, 'YYYYMMDD') || '&limit=100',
        timeout_milliseconds := 20000);
      insert into public.espn_gamelog_requests (request_id, league, kind, slate_date)
      values (v_req, b.league, 'scoreboard', d);
      v_sb := v_sb + 1;
    end loop;
    update public.espn_gamelog_backfill_state
       set cursor_date = b.cursor_date - 2,
           done = (b.cursor_date - 2) < b.floor_date,
           updated_at = now()
     where league = b.league;
  end loop;

  for e in
    select league, event_id from public.espn_game_events
     where completed and box_ingested_at is null and box_attempts < 5
       and (box_requested_at is null or box_requested_at < now() - interval '30 minutes')
     order by event_date desc, event_id
     limit 12
  loop
    v_req := net.http_get(
      url := 'https://site.api.espn.com/apis/site/v2/sports/' || (v_path->>e.league)
             || '/summary?event=' || e.event_id,
      timeout_milliseconds := 30000);
    insert into public.espn_gamelog_requests (request_id, league, kind, event_id)
    values (v_req, e.league, 'summary', e.event_id);
    update public.espn_game_events
       set box_requested_at = now(), box_attempts = box_attempts + 1
     where league = e.league and event_id = e.event_id;
    v_box := v_box + 1;
  end loop;

  return jsonb_build_object('scoreboards', v_sb, 'summaries', v_box);
end
$$;
-- anon-exec: revoked (espn_gamelog_dispatch) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_gamelog_dispatch() from public, anon, authenticated;
grant execute on function public.espn_gamelog_dispatch() to postgres, service_role;

create or replace function public.espn_gamelog_drain()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started  timestamptz := clock_timestamp();
  q          record;
  v_body     jsonb;
  v_reqs     int := 0;
  v_errs     int := 0;
  v_events   int := 0;
  v_boxes    int := 0;
  v_rows     int := 0;
  v_n        int;
  v_err_text text;
  v_error    text;
  v_ok       boolean;
  v_done     boolean;
  v_ev       record;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_gamelog_drain')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  for q in
    select a.request_id, a.league, a.kind, a.event_id, a.slate_date,
           r0.status_code, r0.content, r0.error_msg, r0.timed_out
      from public.espn_gamelog_requests a
      left join net._http_response r0 on r0.id = a.request_id
     where a.drained_at is null
       and (r0.id is not null or a.dispatched_at < now() - interval '10 minutes')
     order by (a.kind = 'summary'), a.dispatched_at
     limit 40
  loop
    v_reqs := v_reqs + 1;
    begin
      if q.status_code is null or q.status_code <> 200 or q.timed_out then
        raise exception 'espn % % % (%): %', q.league, q.kind, coalesce(q.status_code::text, 'no-response'),
          coalesce(q.error_msg, ''), left(coalesce(q.content, ''), 120);
      end if;
      v_body := q.content::jsonb;

      if q.kind = 'scoreboard' then
        if jsonb_typeof(v_body->'events') is distinct from 'array' then
          raise exception 'espn scoreboard 200 without events[]: %', left(q.content, 160);
        end if;
        insert into public.espn_game_events as t
          (league, event_id, event_date, starts_at, season, season_type, home_abbr, away_abbr, state, completed)
        select q.league, ev->>'id',
               ((ev->>'date')::timestamptz at time zone 'America/Los_Angeles')::date,
               (ev->>'date')::timestamptz,
               (ev->'season'->>'year')::int, (ev->'season'->>'type')::int,
               (select c->'team'->>'abbreviation' from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'home'),
               (select c->'team'->>'abbreviation' from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'away'),
               ev->'status'->'type'->>'state',
               coalesce((ev->'status'->'type'->>'completed')::boolean, false)
          from jsonb_array_elements(v_body->'events') ev
         where ev->>'id' is not null
        on conflict (league, event_id) do update set
          event_date = excluded.event_date, starts_at = excluded.starts_at,
          season = excluded.season, season_type = excluded.season_type,
          home_abbr = excluded.home_abbr, away_abbr = excluded.away_abbr,
          state = excluded.state, completed = excluded.completed, updated_at = now()
        where (t.state, t.completed, t.starts_at) is distinct from (excluded.state, excluded.completed, excluded.starts_at);
        get diagnostics v_n = row_count;
        v_events := v_events + v_n;
        update public.espn_gamelog_requests
           set drained_at = now(),
               outcome = jsonb_build_object('ok', true, 'events', jsonb_array_length(v_body->'events'), 'changed', v_n)
         where request_id = q.request_id;

      else
        v_done := coalesce((v_body->'header'->'competitions'->0->'status'->'type'->>'completed')::boolean, false);
        if not v_done then
          update public.espn_game_events set box_requested_at = null, completed = false, updated_at = now()
           where league = q.league and event_id = q.event_id;
          update public.espn_gamelog_requests
             set drained_at = now(), outcome = jsonb_build_object('ok', true, 'not_final', true)
           where request_id = q.request_id;
          continue;
        end if;
        if jsonb_typeof(v_body->'boxscore'->'players') is distinct from 'array' then
          raise exception 'espn summary % without boxscore.players[]', q.event_id;
        end if;
        select * into v_ev from public.espn_game_events where league = q.league and event_id = q.event_id;

        with comp as (
          select c->>'homeAway' as ha, c->'team'->>'abbreviation' as abbr
            from jsonb_array_elements(v_body->'header'->'competitions'->0->'competitors') c
        ), raw as (
          select distinct on (a->'athlete'->>'id', coalesce(s->>'name', ''))
                 p->'team'->>'abbreviation' as team, coalesce(s->>'name', '') as cat,
                 s->'keys' as keys, a
            from jsonb_array_elements(v_body->'boxscore'->'players') p
           cross join jsonb_array_elements(coalesce(p->'statistics', '[]'::jsonb)) s
           cross join jsonb_array_elements(coalesce(s->'athletes', '[]'::jsonb)) a
           where a->'athlete'->>'id' is not null
        ), shaped as (
          select r.team, r.cat, r.a,
                 case when jsonb_typeof(r.a->'stats') = 'array' and jsonb_typeof(r.keys) = 'array'
                       and jsonb_array_length(r.a->'stats') = jsonb_array_length(r.keys)
                       and jsonb_array_length(r.keys) > 0
                      then (select jsonb_object_agg(k.k, v.v)
                              from jsonb_array_elements_text(r.keys) with ordinality k(k, i)
                              join jsonb_array_elements_text(r.a->'stats') with ordinality v(v, j) on i = j)
                      else '{}'::jsonb end as st
            from raw r
        )
        insert into public.player_game_stats as t
          (league, event_id, espn_id, category, game_date, season, season_type, team_abbr, opponent_abbr,
           is_home, starter, did_not_play, minutes, stats, fantasy_points, refreshed_at)
        select q.league, q.event_id, sh.a->'athlete'->>'id', sh.cat,
               coalesce(v_ev.event_date, ((v_body->'header'->'competitions'->0->>'date')::timestamptz at time zone 'America/Los_Angeles')::date),
               coalesce(v_ev.season, (v_body->'header'->'season'->>'year')::int),
               coalesce(v_ev.season_type, (v_body->'header'->'season'->>'type')::int),
               sh.team,
               (select abbr from comp where abbr is distinct from sh.team limit 1),
               (select ha = 'home' from comp where abbr = sh.team limit 1),
               (sh.a->>'starter')::boolean,
               coalesce((sh.a->>'didNotPlay')::boolean, false) or sh.st = '{}'::jsonb,
               public.espn_num(sh.st->>'minutes'),
               sh.st,
               case when sh.st = '{}'::jsonb then null else public.espn_game_fantasy(q.league, sh.cat, sh.st) end,
               now()
          from shaped sh
        on conflict (league, event_id, espn_id, category) do update set
          game_date = excluded.game_date, season = excluded.season, season_type = excluded.season_type,
          team_abbr = excluded.team_abbr, opponent_abbr = excluded.opponent_abbr, is_home = excluded.is_home,
          starter = excluded.starter, did_not_play = excluded.did_not_play, minutes = excluded.minutes,
          stats = excluded.stats, fantasy_points = excluded.fantasy_points, refreshed_at = now();
        get diagnostics v_n = row_count;
        v_rows := v_rows + v_n;
        v_boxes := v_boxes + 1;

        update public.espn_game_events
           set box_ingested_at = now(), box_rows = v_n, box_last_error = null, updated_at = now()
         where league = q.league and event_id = q.event_id;
        update public.espn_gamelog_requests
           set drained_at = now(), outcome = jsonb_build_object('ok', true, 'rows', v_n)
         where request_id = q.request_id;
      end if;

    -- when-others-timeout-blind: intentional — the loop swallows and continues; a statement_timeout
    -- kill must abort the whole drain (the cadence watchlist sees the silence), not be swallowed here.
    exception when others then
      get stacked diagnostics v_err_text = message_text;
      v_errs := v_errs + 1;
      update public.espn_gamelog_requests
         set drained_at = now(), outcome = jsonb_build_object('ok', false, 'error', left(v_err_text, 300))
       where request_id = q.request_id;
      if q.kind = 'summary' then
        update public.espn_game_events set box_last_error = left(v_err_text, 300)
         where league = q.league and event_id = q.event_id;
      end if;
      v_error := coalesce(v_error || ' | ', '') || left(v_err_text, 200);
    end;
  end loop;

  if v_reqs = 0 then
    return jsonb_build_object('drained', 0);
  end if;

  v_ok := v_errs = 0 or v_errs < v_reqs / 4.0;

  perform public.log_pipeline_run(
    'espn-game-logs', v_started, v_events + v_boxes, v_rows, 0, v_ok, v_error,
    null, null, null,
    jsonb_build_object('requests', v_reqs, 'request_errors', v_errs, 'events_changed', v_events,
                       'boxscores', v_boxes, 'player_rows', v_rows,
                       'queue_pending', (select count(*) from public.espn_game_events
                                          where completed and box_ingested_at is null and box_attempts < 5),
                       'backfill_open', (select coalesce(jsonb_object_agg(league, cursor_date), '{}'::jsonb)
                                           from public.espn_gamelog_backfill_state where not done),
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('ok', v_ok, 'requests', v_reqs, 'errors', v_errs, 'events_changed', v_events,
                            'boxscores', v_boxes, 'rows', v_rows, 'error', v_error);
end
$$;
-- anon-exec: revoked (espn_gamelog_drain) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_gamelog_drain() from public, anon, authenticated;
grant execute on function public.espn_gamelog_drain() to postgres, service_role;

create view public.player_game_market_moves with (security_invoker = on) as
with g as (
  select league, espn_id, event_id, game_date, season, season_type,
         max(team_abbr) as team_abbr, max(opponent_abbr) as opponent_abbr, bool_or(is_home) as is_home,
         bool_and(did_not_play) as did_not_play, max(minutes) as minutes,
         sum(fantasy_points) as fantasy_points
    from public.player_game_stats
   group by league, espn_id, event_id, game_date, season, season_type
), gw as (
  select g.*,
         avg(g.fantasy_points) filter (where not g.did_not_play) over (
           partition by g.league, g.espn_id, g.season order by g.game_date
           rows between unbounded preceding and 1 preceding) as fp_season_avg_before,
         count(*) filter (where not g.did_not_play) over (
           partition by g.league, g.espn_id, g.season order by g.game_date
           rows between unbounded preceding and 1 preceding) as games_before
    from g
), pid as (
  select distinct on (c.slug, pi.espn_id) c.slug as collection_slug, pi.espn_id, pi.name_slug, pi.display_name
    from public.player_identities pi
    join public.collections c on c.id = pi.collection_id
   where pi.espn_id is not null and pi.name_slug is not null
   order by c.slug, pi.espn_id, pi.matched_at desc nulls last
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
  join pid on pid.espn_id = gw.espn_id
          and pid.collection_slug = case gw.league when 'nfl' then 'nfl_all_day' when 'mlb' then 'candy_mlb' else 'nba_top_shot' end
  left join public.market_cap_daily m0 on m0.snapshot_date = gw.game_date - 1 and m0.collection_slug = pid.collection_slug
        and m0.grain = 'player' and m0.group_key = pid.name_slug
  left join public.market_cap_daily m1 on m1.snapshot_date = gw.game_date + 1 and m1.collection_slug = pid.collection_slug
        and m1.grain = 'player' and m1.group_key = pid.name_slug
  left join public.market_cap_daily m3 on m3.snapshot_date = gw.game_date + 3 and m3.collection_slug = pid.collection_slug
        and m3.grain = 'player' and m3.group_key = pid.name_slug;
revoke all on public.player_game_market_moves from anon, authenticated;

insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
values ('espn-game-logs', 60, 360, 'info',
  'Added 2026-11-08 with the ESPN per-game box-score lane (espn_gamelog_dispatch every 10 min at :04, espn_gamelog_drain at :07; pg_net, same egress as nba-espn-projections). Live scoreboards twice an hour (yesterday+today, nba/wnba/nfl/mlb) so the drain logs at least every 30 min. ok=false when >=25% of a tick''s requests fail. info until a human read promotes it.',
  true);

select cron.schedule('rpc-espn-gamelog-dispatch', '4,14,24,34,44,54 * * * *', 'select public.espn_gamelog_dispatch()');
select cron.schedule('rpc-espn-gamelog-drain',    '7,17,27,37,47,57 * * * *', 'select public.espn_gamelog_drain()');