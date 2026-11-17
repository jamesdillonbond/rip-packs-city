-- audit_20261108_espn_game_logs_laliga
-- Adds LaLiga (ESPN soccer/esp.1) to the per-game box-score lane of 20261108174208, and a
-- Golazos ↔ ESPN crosswalk built from the box scores themselves, so Golazos players join
-- player_game_market_moves the way Top Shot / All Day / Candy players do.
--
-- Why a separate crosswalk table and NOT player_identities: player_identities is read by the
-- NAME WRITERS (link_editions_to_players_by_name, ensure_players_from_edition_names,
-- resolve_canonical_player, resolve_player_identity). A Golazos row there would let ESPN's
-- spelling reach Golazos names. golazos_espn_crosswalk is read by the view below and nothing else.
--
-- Match rule (refresh_golazos_espn_crosswalk): a Golazos market-cap player key (group_key, the
-- label slug) matches an ESPN LaLiga athlete seen in a box score when the slug of ESPN's display
-- name OR full name equals it AND exactly ONE such athlete exists. Two ESPN athletes on one slug
-- → recorded as ambiguous with no espn_id. "A name is not a person": a unique-within-LaLiga name
-- match on players who appeared in a 2026 LaLiga match is the strongest key available without a
-- league id; retired Golazos legends (Messi, Benzema…) never appear and stay unmatched.
--
-- Soccer "fantasy_points" is an RPC performance index, not a game's scoring: appearance 1,
-- goal 6, assist 4, shot on target 1, save 0.5, yellow -1, red -3, own goal -2.
--
-- Revert:
--   delete from public.espn_gamelog_backfill_state where league = 'laliga';
--   delete from public.player_game_stats where league = 'laliga';
--   delete from public.espn_game_events where league = 'laliga';
--   drop table public.golazos_espn_crosswalk; drop table public.espn_athletes;
--   drop function public.refresh_golazos_espn_crosswalk(), public.espn_box_rows(text, jsonb), public.rpc_name_slug(text);
--   then re-apply the 20261108174208 bodies of espn_game_fantasy, espn_gamelog_dispatch,
--   espn_gamelog_drain and player_game_market_moves, and restore the league CHECKs without 'laliga'.

alter table public.espn_game_events drop constraint espn_game_events_league_check;
alter table public.espn_game_events add constraint espn_game_events_league_check
  check (league in ('nba','wnba','nfl','mlb','laliga'));
alter table public.player_game_stats drop constraint player_game_stats_league_check;
alter table public.player_game_stats add constraint player_game_stats_league_check
  check (league in ('nba','wnba','nfl','mlb','laliga'));

insert into public.espn_gamelog_backfill_state (league, cursor_date, floor_date)
values ('laliga', (now() at time zone 'America/Los_Angeles')::date - 2, date '2026-08-14');

-- Every athlete a box score names, with ESPN's spellings: the crosswalk's matching population.
create table public.espn_athletes (
  league         text not null,
  espn_id        text not null,
  display_name   text,
  full_name      text,
  short_name     text,
  team_abbr      text,
  last_seen_date date,
  updated_at     timestamptz not null default now(),
  primary key (league, espn_id)
);
alter table public.espn_athletes enable row level security;
revoke all on public.espn_athletes from anon, authenticated;

create table public.golazos_espn_crosswalk (
  name_slug          text primary key,      -- market_cap_daily group_key for laliga_golazos
  player_label       text not null,
  espn_id            text,                  -- NULL when ambiguous
  espn_display_name  text,
  matched_by         text not null,         -- 'laliga-boxscore-unique-name' | 'ambiguous'
  candidates         jsonb,
  matched_at         timestamptz not null default now()
);
alter table public.golazos_espn_crosswalk enable row level security;
revoke all on public.golazos_espn_crosswalk from anon, authenticated;

-- The label slug market_cap_daily uses: accent-folded, lower, non-alphanumeric runs → '-'.
create or replace function public.rpc_name_slug(p text)
returns text language sql stable parallel safe
set search_path = pg_catalog, public, extensions
as $$
  select nullif(trim(both '-' from regexp_replace(lower(extensions.unaccent(coalesce(p, ''))), '[^a-z0-9]+', '-', 'g')), '')
$$;
-- anon-exec: revoked (rpc_name_slug) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.rpc_name_slug(text) from public, anon, authenticated;
grant execute on function public.rpc_name_slug(text) to postgres, service_role;

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
    when p_league = 'laliga' then
        case when coalesce(public.espn_num(s->>'appearances'),0) > 0 then 1 else 0 end
      + 6   * coalesce(public.espn_num(s->>'totalGoals'),0)
      + 4   * coalesce(public.espn_num(s->>'goalAssists'),0)
      + 1   * coalesce(public.espn_num(s->>'shotsOnTarget'),0)
      + 0.5 * coalesce(public.espn_num(s->>'saves'),0)
      - 1   * coalesce(public.espn_num(s->>'yellowCards'),0)
      - 3   * coalesce(public.espn_num(s->>'redCards'),0)
      - 2   * coalesce(public.espn_num(s->>'ownGoals'),0)
  end
$$;
-- anon-exec: unchanged (espn_game_fantasy) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

-- One row per athlete per box-score group, from either summary shape:
--   basketball/football/baseball: boxscore.players[].statistics[] { name, keys[], athletes[] { athlete, stats[] } }
--   soccer: rosters[] { team, roster[] { athlete, starter, stats[] { name, displayValue } } }
create or replace function public.espn_box_rows(p_league text, p_body jsonb)
returns table (espn_id text, category text, team_abbr text, starter boolean, did_not_play boolean,
               stats jsonb, display_name text, full_name text, short_name text)
language sql stable parallel safe
set search_path = pg_catalog, public
as $$
  with box as (
    select distinct on (a->'athlete'->>'id', coalesce(s->>'name', ''))
           a->'athlete'->>'id' as id, coalesce(s->>'name', '') as cat, p->'team'->>'abbreviation' as team, a,
           case when jsonb_typeof(a->'stats') = 'array' and jsonb_typeof(s->'keys') = 'array'
                 and jsonb_array_length(a->'stats') = jsonb_array_length(s->'keys')
                 and jsonb_array_length(s->'keys') > 0
                then (select jsonb_object_agg(k.k, v.v)
                        from jsonb_array_elements_text(s->'keys') with ordinality k(k, i)
                        join jsonb_array_elements_text(a->'stats') with ordinality v(v, j) on i = j)
                else '{}'::jsonb end as st
      from jsonb_array_elements(case when p_league = 'laliga' then '[]'::jsonb else coalesce(p_body->'boxscore'->'players', '[]'::jsonb) end) p
     cross join jsonb_array_elements(coalesce(p->'statistics', '[]'::jsonb)) s
     cross join jsonb_array_elements(coalesce(s->'athletes', '[]'::jsonb)) a
     where a->'athlete'->>'id' is not null
  ), soc as (
    select distinct on (a->'athlete'->>'id')
           a->'athlete'->>'id' as id, ''::text as cat, r->'team'->>'abbreviation' as team, a,
           coalesce((select jsonb_object_agg(x->>'name', x->>'displayValue')
                       from jsonb_array_elements(coalesce(a->'stats', '[]'::jsonb)) x
                      where x->>'name' is not null), '{}'::jsonb) as st
      from jsonb_array_elements(case when p_league = 'laliga' then coalesce(p_body->'rosters', '[]'::jsonb) else '[]'::jsonb end) r
     cross join jsonb_array_elements(coalesce(r->'roster', '[]'::jsonb)) a
     where a->'athlete'->>'id' is not null
  ), u as (select * from box union all select * from soc)
  select u.id, u.cat, u.team,
         (u.a->>'starter')::boolean,
         coalesce((u.a->>'didNotPlay')::boolean, false)
           or u.st = '{}'::jsonb
           or (p_league = 'laliga' and coalesce(public.espn_num(u.st->>'appearances'), 0) = 0),
         u.st,
         u.a->'athlete'->>'displayName', u.a->'athlete'->>'fullName', u.a->'athlete'->>'shortName'
    from u
$$;
-- anon-exec: revoked (espn_box_rows) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_box_rows(text, jsonb) from public, anon, authenticated;
grant execute on function public.espn_box_rows(text, jsonb) to postgres, service_role;

create or replace function public.refresh_golazos_espn_crosswalk()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_matched int; v_ambiguous int;
begin
  with g as (
    select group_key as name_slug, max(group_label) as player_label
      from public.market_cap_current
     where collection_slug = 'laliga_golazos' and grain = 'player' and is_primary
     group by group_key
  ), e as (
    select a.espn_id, a.display_name, s.slug
      from public.espn_athletes a
     cross join lateral (select distinct x from unnest(array[public.rpc_name_slug(a.display_name),
                                                             public.rpc_name_slug(a.full_name)]) x
                          where x is not null) s(slug)
     where a.league = 'laliga'
  ), m as (
    select g.name_slug, g.player_label,
           count(distinct e.espn_id) as n,
           min(e.espn_id) as espn_id, min(e.display_name) as espn_display_name,
           jsonb_agg(distinct jsonb_build_object('espn_id', e.espn_id, 'name', e.display_name)) as candidates
      from g join e on e.slug = g.name_slug
     group by g.name_slug, g.player_label
  ), d as (
    delete from public.golazos_espn_crosswalk c where not exists (select 1 from m where m.name_slug = c.name_slug)
    returning 1
  )
  insert into public.golazos_espn_crosswalk as c (name_slug, player_label, espn_id, espn_display_name, matched_by, candidates, matched_at)
  select name_slug, player_label,
         case when n = 1 then espn_id end, case when n = 1 then espn_display_name end,
         case when n = 1 then 'laliga-boxscore-unique-name' else 'ambiguous' end,
         case when n = 1 then null else candidates end, now()
    from m
  on conflict (name_slug) do update set
    player_label = excluded.player_label, espn_id = excluded.espn_id, espn_display_name = excluded.espn_display_name,
    matched_by = excluded.matched_by, candidates = excluded.candidates,
    matched_at = case when (c.espn_id, c.matched_by) is distinct from (excluded.espn_id, excluded.matched_by)
                      then now() else c.matched_at end;

  select count(*) filter (where espn_id is not null), count(*) filter (where espn_id is null)
    into v_matched, v_ambiguous from public.golazos_espn_crosswalk;
  return jsonb_build_object('matched', v_matched, 'ambiguous', v_ambiguous);
end
$$;
-- anon-exec: revoked (refresh_golazos_espn_crosswalk) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.refresh_golazos_espn_crosswalk() from public, anon, authenticated;
grant execute on function public.refresh_golazos_espn_crosswalk() to postgres, service_role;

create or replace function public.espn_gamelog_dispatch()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_min   int  := extract(minute from now())::int;
  v_path  jsonb := '{"nba":"basketball/nba","wnba":"basketball/wnba","nfl":"football/nfl","mlb":"baseball/mlb","laliga":"soccer/esp.1"}';
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
    for l in select jsonb_object_keys(v_path) loop
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
-- anon-exec: unchanged (espn_gamelog_dispatch) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

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
  v_laliga   int := 0;
  v_rows     int := 0;
  v_n        int;
  v_err_text text;
  v_error    text;
  v_ok       boolean;
  v_done     boolean;
  v_ev       record;
  v_xwalk    jsonb;
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
        if q.league = 'laliga' then
          if jsonb_typeof(v_body->'rosters') is distinct from 'array' then
            raise exception 'espn summary % without rosters[]', q.event_id;
          end if;
        elsif jsonb_typeof(v_body->'boxscore'->'players') is distinct from 'array' then
          raise exception 'espn summary % without boxscore.players[]', q.event_id;
        end if;
        select * into v_ev from public.espn_game_events where league = q.league and event_id = q.event_id;

        with comp as (
          select c->>'homeAway' as ha, c->'team'->>'abbreviation' as abbr
            from jsonb_array_elements(v_body->'header'->'competitions'->0->'competitors') c
        ), br as (
          select * from public.espn_box_rows(q.league, v_body)
        ), ath as (
          insert into public.espn_athletes as t (league, espn_id, display_name, full_name, short_name, team_abbr, last_seen_date, updated_at)
          select distinct on (br.espn_id) q.league, br.espn_id, br.display_name, br.full_name, br.short_name, br.team_abbr,
                 v_ev.event_date, now()
            from br
          on conflict (league, espn_id) do update set
            display_name = excluded.display_name, full_name = excluded.full_name, short_name = excluded.short_name,
            team_abbr = case when excluded.last_seen_date >= coalesce(t.last_seen_date, excluded.last_seen_date)
                             then excluded.team_abbr else t.team_abbr end,
            last_seen_date = greatest(t.last_seen_date, excluded.last_seen_date), updated_at = now()
          returning 1
        )
        insert into public.player_game_stats as t
          (league, event_id, espn_id, category, game_date, season, season_type, team_abbr, opponent_abbr,
           is_home, starter, did_not_play, minutes, stats, fantasy_points, refreshed_at)
        select q.league, q.event_id, br.espn_id, br.category,
               coalesce(v_ev.event_date, ((v_body->'header'->'competitions'->0->>'date')::timestamptz at time zone 'America/Los_Angeles')::date),
               coalesce(v_ev.season, (v_body->'header'->'season'->>'year')::int),
               coalesce(v_ev.season_type, (v_body->'header'->'season'->>'type')::int),
               br.team_abbr,
               (select abbr from comp where abbr is distinct from br.team_abbr limit 1),
               (select ha = 'home' from comp where abbr = br.team_abbr limit 1),
               br.starter, br.did_not_play,
               public.espn_num(br.stats->>'minutes'),
               br.stats,
               case when br.did_not_play then null else public.espn_game_fantasy(q.league, br.category, br.stats) end,
               now()
          from br
        on conflict (league, event_id, espn_id, category) do update set
          game_date = excluded.game_date, season = excluded.season, season_type = excluded.season_type,
          team_abbr = excluded.team_abbr, opponent_abbr = excluded.opponent_abbr, is_home = excluded.is_home,
          starter = excluded.starter, did_not_play = excluded.did_not_play, minutes = excluded.minutes,
          stats = excluded.stats, fantasy_points = excluded.fantasy_points, refreshed_at = now();
        get diagnostics v_n = row_count;
        v_rows := v_rows + v_n;
        v_boxes := v_boxes + 1;
        if q.league = 'laliga' then v_laliga := v_laliga + 1; end if;

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

  if v_laliga > 0 then
    v_xwalk := public.refresh_golazos_espn_crosswalk();
  end if;

  v_ok := v_errs = 0 or v_errs < v_reqs / 4.0;

  perform public.log_pipeline_run(
    'espn-game-logs', v_started, v_events + v_boxes, v_rows, 0, v_ok, v_error,
    null, null, null,
    jsonb_build_object('requests', v_reqs, 'request_errors', v_errs, 'events_changed', v_events,
                       'boxscores', v_boxes, 'player_rows', v_rows, 'golazos_crosswalk', v_xwalk,
                       'queue_pending', (select count(*) from public.espn_game_events
                                          where completed and box_ingested_at is null and box_attempts < 5),
                       'backfill_open', (select coalesce(jsonb_object_agg(league, cursor_date), '{}'::jsonb)
                                           from public.espn_gamelog_backfill_state where not done),
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('ok', v_ok, 'requests', v_reqs, 'errors', v_errs, 'events_changed', v_events,
                            'boxscores', v_boxes, 'rows', v_rows, 'golazos_crosswalk', v_xwalk, 'error', v_error);
end
$$;
-- anon-exec: unchanged (espn_gamelog_drain) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

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
         avg(g.fantasy_points) filter (where not g.did_not_play) over (
           partition by g.league, g.espn_id, g.season order by g.game_date
           rows between unbounded preceding and 1 preceding) as fp_season_avg_before,
         count(*) filter (where not g.did_not_play) over (
           partition by g.league, g.espn_id, g.season order by g.game_date
           rows between unbounded preceding and 1 preceding) as games_before
    from g
), pid as (
  (select distinct on (c.slug, pi.espn_id) c.slug as collection_slug, pi.espn_id, pi.name_slug, pi.display_name
     from public.player_identities pi
     join public.collections c on c.id = pi.collection_id
    where pi.espn_id is not null and pi.name_slug is not null
    order by c.slug, pi.espn_id, pi.matched_at desc nulls last)
  union all
  select 'laliga_golazos'::varchar(50), x.espn_id, x.name_slug, x.player_label
    from public.golazos_espn_crosswalk x
   where x.espn_id is not null
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
          and pid.collection_slug = case gw.league when 'nfl' then 'nfl_all_day' when 'mlb' then 'candy_mlb'
                                                   when 'laliga' then 'laliga_golazos' else 'nba_top_shot' end
  left join public.market_cap_daily m0 on m0.snapshot_date = gw.game_date - 1 and m0.collection_slug = pid.collection_slug
        and m0.grain = 'player' and m0.group_key = pid.name_slug
  left join public.market_cap_daily m1 on m1.snapshot_date = gw.game_date + 1 and m1.collection_slug = pid.collection_slug
        and m1.grain = 'player' and m1.group_key = pid.name_slug
  left join public.market_cap_daily m3 on m3.snapshot_date = gw.game_date + 3 and m3.collection_slug = pid.collection_slug
        and m3.grain = 'player' and m3.group_key = pid.name_slug;
revoke all on public.player_game_market_moves from anon, authenticated;