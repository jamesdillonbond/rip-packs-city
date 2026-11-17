-- audit_20261108_espn_gamelog_throughput
-- Box scores per tick 16 → 40 and drain batch 48 → 96. Measured 10:30 AM PT 11-08: the queue of
-- completed-but-unfetched games grew 40 → 161 over five ticks because the 12-league backfill
-- discovers games faster than 16 summaries/tick fetch them (≈650 games to Oct 1 / Aug 14), while
-- each drain took 0.3–1.4 s for 12–16 box scores. 40 per tick is 4 ESPN requests a minute and
-- ~2.5–3.5 s of drain; the backlog clears in ~3 h instead of ~7.
-- Bodies are the 20261108183002 bodies with only the two LIMITs changed (diffed before apply).
--
-- Revert: re-apply the 20261108183002 bodies of espn_gamelog_dispatch and espn_gamelog_drain.

create or replace function public.espn_gamelog_dispatch()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_min   int  := extract(minute from now())::int;
  v_req   bigint;
  v_sb    int := 0;
  v_box   int := 0;
  l       record;
  d       date;
  b       record;
  e       record;
begin
  if exists (select 1 from public.espn_gamelog_requests
              where drained_at is null and dispatched_at > now() - interval '10 minutes') then
    return jsonb_build_object('skipped', 'in_flight');
  end if;

  if v_min < 10 or (v_min >= 30 and v_min < 40) then
    for l in select league, path from public.espn_leagues where is_active order by league loop
      foreach d in array array[v_today - 1, v_today] loop
        v_req := net.http_get(
          url := 'https://site.api.espn.com/apis/site/v2/sports/' || l.path
                 || '/scoreboard?dates=' || to_char(d, 'YYYYMMDD') || '&limit=100',
          timeout_milliseconds := 20000);
        insert into public.espn_gamelog_requests (request_id, league, kind, slate_date)
        values (v_req, l.league, 'scoreboard', d);
        v_sb := v_sb + 1;
      end loop;
    end loop;
  end if;

  for b in select s.*, lg.path from public.espn_gamelog_backfill_state s
             join public.espn_leagues lg on lg.league = s.league and lg.is_active
            where not s.done order by s.league loop
    foreach d in array array[b.cursor_date, b.cursor_date - 1] loop
      exit when d < b.floor_date;
      v_req := net.http_get(
        url := 'https://site.api.espn.com/apis/site/v2/sports/' || b.path
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
    select ev.league, ev.event_id, lg.path from public.espn_game_events ev
      join public.espn_leagues lg on lg.league = ev.league and lg.is_active
     where ev.completed and ev.box_ingested_at is null and ev.box_attempts < 5
       and (ev.box_requested_at is null or ev.box_requested_at < now() - interval '30 minutes')
     order by ev.event_date desc, ev.event_id
     limit 40
  loop
    v_req := net.http_get(
      url := 'https://site.api.espn.com/apis/site/v2/sports/' || e.path
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
  v_soccer   int := 0;
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
           (public.espn_league_sport(a.league) = 'soccer') as soccer,
           r0.status_code, r0.content, r0.error_msg, r0.timed_out
      from public.espn_gamelog_requests a
      left join net._http_response r0 on r0.id = a.request_id
     where a.drained_at is null
       and (r0.id is not null or a.dispatched_at < now() - interval '10 minutes')
     order by (a.kind = 'summary'), a.dispatched_at
     limit 96
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
        if q.soccer then
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
        if q.soccer then v_soccer := v_soccer + 1; end if;

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

  if v_soccer > 0 then
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