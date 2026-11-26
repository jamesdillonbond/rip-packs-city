-- audit_20261125_moment_game_lines_allday_needs_a_game
--
-- All Day editions without both home_team and away_team are not game plays (measured 2026-11-25:
-- 355 of 6,079 dated All Day editions — 280 "Player Melt" composites dated 2023-09-10, Team Melts
-- dated Jan 1, Draft Picks dated draft day, a few unfilled placeholders). Every real All Day game
-- carries both teams (0 editions whose team_name is outside its own game). Their date names no game
-- and no season, so:
--   · get_moment_game_context returns NULL for them (the slab shows no stats — no claim);
--   · moment_gamelog_targets / moment_gamelog_drain skip them (no ESPN request, no lines kept).
-- Also measured: 69 / 69 sampled All Day games match ESPN on the US date (0 UTC-only, 0 conflicts),
-- 68 / 69 opponents equal ESPN's (the miss is the Washington rename) — the exact-date reader of
-- 20261126020836 holds for All Day.
-- Bodies otherwise identical to the live ones (prosrc md5 of each verified equal to its file).
--
-- Revert: re-apply moment_gamelog_targets / moment_gamelog_drain from 20261126020013 and
-- get_moment_game_context from 20261126020836.

create or replace function public.moment_gamelog_targets(p_limit int default 24)
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
      or (f.status = 'ok' and f.fetched_at < now() - interval '7 days')
   order by (f.espn_id is null) desc, n.last_date desc, n.espn_id
   limit greatest(1, least(coalesce(p_limit, 24), 100))
$$;
-- anon-exec: unchanged (moment_gamelog_targets) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-25.

create or replace function public.moment_gamelog_drain()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started  timestamptz := clock_timestamp();
  q          record;
  v_body     jsonb;
  v_dates    date[];
  v_kept     int;
  v_reqs     int := 0;
  v_errs     int := 0;
  v_rows     int := 0;
  v_err_text text;
  v_error    text;
  v_ok       boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('moment_gamelog_drain')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  for q in
    select a.request_id, a.espn_league, a.espn_id, a.season,
           r0.status_code, r0.content, r0.error_msg, r0.timed_out
      from public.player_gamelog_requests a
      left join net._http_response r0 on r0.id = a.request_id
     where a.drained_at is null
       and (r0.id is not null or a.dispatched_at < now() - interval '10 minutes')
     order by a.dispatched_at
     limit 60
  loop
    v_reqs := v_reqs + 1;
    begin
      if q.status_code is null or q.status_code <> 200 or q.timed_out then
        raise exception 'espn gamelog % % % (%): %', q.espn_league, q.espn_id, coalesce(q.status_code::text, 'no-response'),
          coalesce(q.error_msg, ''), left(coalesce(q.content, ''), 120);
      end if;
      v_body := q.content::jsonb;

      -- the dates this athlete's Moments point at, in this season
      select array_agg(distinct e.game_date) into v_dates
        from public.editions e
        join public.collections c on c.id = e.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day')
        join public.player_identities i on i.player_id = e.player_id
       where i.espn_id = q.espn_id and coalesce(i.espn_league, i.league) = q.espn_league
         and e.game_date is not null
         and (c.slug <> 'nfl_all_day' or (e.home_team is not null and e.away_team is not null))
         and public.moment_gamelog_season(q.espn_league, e.game_date) = q.season;

      with lines as (
        select ev->>'eventId' as event_id,
               st->>'displayName' as season_type_name,
               (meta->>'gameDate')::timestamptz as game_at,
               meta, ev->'stats' as stats
          from jsonb_array_elements(coalesce(v_body->'seasonTypes', '[]'::jsonb)) st
          cross join jsonb_array_elements(coalesce(st->'categories', '[]'::jsonb)) c
          cross join jsonb_array_elements(coalesce(c->'events', '[]'::jsonb)) ev
          cross join lateral (select v_body->'events'->(ev->>'eventId') as meta) m
         where c->>'type' = 'event' and m.meta ? 'gameDate' and jsonb_typeof(ev->'stats') = 'array'
      ), kept as (
        select distinct on (l.event_id) l.*,
               (l.game_at at time zone 'America/New_York')::date as d_us,
               (l.game_at at time zone 'UTC')::date as d_utc
          from lines l
         where exists (select 1 from unnest(coalesce(v_dates, '{}'::date[])) d
                        where (l.game_at at time zone 'UTC')::date between d - 1 and d + 1
                           or (l.game_at at time zone 'America/New_York')::date between d - 1 and d + 1)
         order by l.event_id
      )
      insert into public.player_gamelog_lines as t
        (espn_league, espn_id, event_id, season, season_type_name, game_at, game_date, game_date_utc,
         at_vs, opponent_abbr, opponent_name, score, result, names, labels, "values", refreshed_at)
      select q.espn_league, q.espn_id, k.event_id, q.season, k.season_type_name, k.game_at, k.d_us, k.d_utc,
             k.meta->>'atVs', k.meta->'opponent'->>'abbreviation', k.meta->'opponent'->>'displayName',
             k.meta->>'score', k.meta->>'gameResult',
             array(select jsonb_array_elements_text(coalesce(v_body->'names', '[]'::jsonb))),
             array(select jsonb_array_elements_text(coalesce(v_body->'labels', '[]'::jsonb))),
             array(select jsonb_array_elements_text(k.stats)),
             now()
        from kept k
      on conflict (espn_league, espn_id, event_id) do update
         set season = excluded.season, season_type_name = excluded.season_type_name, game_at = excluded.game_at,
             game_date = excluded.game_date, game_date_utc = excluded.game_date_utc, at_vs = excluded.at_vs,
             opponent_abbr = excluded.opponent_abbr, opponent_name = excluded.opponent_name, score = excluded.score,
             result = excluded.result, names = excluded.names, labels = excluded.labels, "values" = excluded."values",
             refreshed_at = now();
      get diagnostics v_kept = row_count;
      v_rows := v_rows + v_kept;

      update public.player_gamelog_fetches
         set status = 'ok', fetched_at = now(), lines_kept = v_kept, last_error = null
       where espn_league = q.espn_league and espn_id = q.espn_id and season = q.season;
      update public.player_gamelog_requests
         set drained_at = now(), outcome = jsonb_build_object('ok', true, 'lines', v_kept)
       where request_id = q.request_id;
    -- when-others-timeout-blind: intentional — record this request's failure and continue to the next;
    -- the loop is bounded (60 requests) and a statement_timeout kill of the whole drain leaves every
    -- undrained request for the next tick, which is the correct outcome.
    exception when others then
      get stacked diagnostics v_err_text = message_text;
      v_errs := v_errs + 1;
      update public.player_gamelog_requests
         set drained_at = now(), outcome = jsonb_build_object('ok', false, 'error', left(v_err_text, 300))
       where request_id = q.request_id;
      update public.player_gamelog_fetches
         set status = 'error', last_error = left(v_err_text, 300)
       where espn_league = q.espn_league and espn_id = q.espn_id and season = q.season;
      v_error := coalesce(v_error || ' | ', '') || left(v_err_text, 200);
    end;
  end loop;

  if v_reqs = 0 then
    return jsonb_build_object('drained', 0);
  end if;

  v_ok := v_errs = 0 or v_errs < v_reqs / 4.0;

  perform public.log_pipeline_run(
    'moment-game-lines', v_started, v_reqs, v_rows, 0, v_ok, v_error,
    null, null, null,
    jsonb_build_object('requests', v_reqs, 'request_errors', v_errs, 'lines_kept', v_rows,
                       'fetched_ok', (select count(*) from public.player_gamelog_fetches where status = 'ok'),
                       'fetch_errors', (select count(*) from public.player_gamelog_fetches where status = 'error'),
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('ok', v_ok, 'requests', v_reqs, 'errors', v_errs, 'lines', v_rows, 'error', v_error);
end
$$;
-- anon-exec: unchanged (moment_gamelog_drain) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-25.

create or replace function public.get_moment_game_context(p_edition_id uuid)
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
-- anon-exec: unchanged (get_moment_game_context) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-25.
