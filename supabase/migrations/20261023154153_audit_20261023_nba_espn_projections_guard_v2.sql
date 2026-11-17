-- audit_20261023_nba_espn_projections_guard_v2
-- Fixes two defects an independent read-only verifier found in 20261023153445 (10-23 ~8:40 AM PT):
-- 1. nba_projection_single_rankable special-cased source = 'espn' exactly, so another ESPN-family
--    source ('espn-team-leader', dead since 07-20) could still sit beside a DraftKings row: 7
--    (player, date) pairs on 2026-05-10 carry two rankable rows. Replaced by a total order:
--    nba_projection_source_rank(): draftkings 1, espn 2, anything else 3. A new rankable row is
--    unranked when a same-or-better-ranked rankable row exists for that player/date (first come
--    wins a tie), and it unranks every worse-ranked one. The 05-10 history is left as recorded
--    (past date; the optimizer reads one date at a time).
-- 2. Noa Essengue had NULL rebounds/assists from ESPN and was scored as if they were 0 (fp 6.16,
--    understated). The drain now skips a player whose projection lacks PTS, AST or REB.
-- Everything else in nba_espn_drain is byte-identical to 20261023153445.
-- Revert: re-apply the two function bodies from 20261023153445.

create or replace function public.nba_projection_source_rank(p_source text)
returns int language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  select case p_source when 'draftkings' then 1 when 'espn' then 2 else 3 end
$$;

create or replace function public.nba_projection_single_rankable()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.proj_fp_dk is null then
    return new;
  end if;
  if exists (
       select 1 from public.nba_player_projections o
        where o.nba_player_id = new.nba_player_id
          and o.game_date = new.game_date
          and o.source <> new.source
          and o.proj_fp_dk is not null
          and public.nba_projection_source_rank(o.source) <= public.nba_projection_source_rank(new.source)) then
    new.proj_fp_dk := null;   -- a same-or-better source already ranks this player on this date
    return new;
  end if;
  update public.nba_player_projections
     set proj_fp_dk = null
   where nba_player_id = new.nba_player_id
     and game_date = new.game_date
     and source <> new.source
     and proj_fp_dk is not null
     and public.nba_projection_source_rank(source) > public.nba_projection_source_rank(new.source);
  return new;
end
$$;

create or replace function public.nba_espn_drain()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started   timestamptz := clock_timestamp();
  v_today     date := (now() at time zone 'America/Los_Angeles')::date;
  q           record;
  r           record;
  v_body      jsonb;
  v_reqs      int := 0;
  v_errs      int := 0;
  v_err_text  text;
  v_games     int := 0;
  v_found     int := 0;
  v_written   int := 0;
  v_inserted  int := 0;
  v_matched   int := 0;
  v_conflicts int := 0;
  v_superseded int := 0;
  v_proj_ok   boolean := null;   -- null = no projections response this tick
  v_slate_games int;
  v_pid       uuid;
  v_fp        numeric;
  v_ten       int;
  v_per_date  jsonb := '{}'::jsonb;
  v_ok        boolean;
  v_error     text;
begin
  if not pg_try_advisory_xact_lock(hashtext('nba_espn_drain')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  for q in
    select a.request_id, a.kind, a.slate_date, a.season_id,
           r0.status_code, r0.content, r0.error_msg, r0.timed_out
      from public.nba_espn_requests a
      left join net._http_response r0 on r0.id = a.request_id
     where a.drained_at is null
       and (r0.id is not null or a.dispatched_at < now() - interval '10 minutes')
     order by (a.kind = 'projections'), a.dispatched_at   -- scoreboards before projections
     limit 12
  loop
    v_reqs := v_reqs + 1;
    begin
      if q.status_code is null or q.status_code <> 200 or q.timed_out then
        raise exception 'espn % % (%): %', q.kind, coalesce(q.status_code::text, 'no-response'),
          coalesce(q.error_msg, ''), left(coalesce(q.content, ''), 120);
      end if;
      v_body := q.content::jsonb;

      if q.kind = 'scoreboard' then
        if jsonb_typeof(v_body->'events') is distinct from 'array' then
          raise exception 'espn scoreboard 200 without events[]: %', left(q.content, 160);
        end if;
        with ev as (
          select e->>'id' as ext_id,
                 (e->>'date')::timestamptz as tipoff,
                 c->'status'->'type'->>'state' as state,
                 c->'status'->'type'->>'name'  as sname,
                 (e->'season'->>'type') = '3' as playoff,
                 (select public.nba_espn_team_abbr((t->'team'->>'id')::int)
                    from jsonb_array_elements(c->'competitors') t where t->>'homeAway' = 'home') as home_abbr,
                 (select public.nba_espn_team_abbr((t->'team'->>'id')::int)
                    from jsonb_array_elements(c->'competitors') t where t->>'homeAway' = 'away') as away_abbr,
                 (select nullif(t->>'score', '')::int
                    from jsonb_array_elements(c->'competitors') t where t->>'homeAway' = 'home') as home_score,
                 (select nullif(t->>'score', '')::int
                    from jsonb_array_elements(c->'competitors') t where t->>'homeAway' = 'away') as away_score
            from jsonb_array_elements(v_body->'events') e
            cross join lateral (select e->'competitions'->0 as c) cc
        ), up as (
          insert into public.nba_games as g
            (external_game_id, game_date, tipoff_at, home_team_abbr, away_team_abbr,
             home_score, away_score, status, is_playoff, last_synced_at)
          select ext_id, q.slate_date, tipoff, home_abbr, away_abbr,
                 case when state = 'pre' then null else home_score end,
                 case when state = 'pre' then null else away_score end,
                 case when sname = 'STATUS_POSTPONED' then 'postponed'
                      when state = 'in' then 'live'
                      when state = 'post' then 'final'
                      else 'scheduled' end,
                 playoff, now()
            from ev
           where home_abbr is not null and away_abbr is not null
          on conflict (external_game_id) do update
             set game_date = excluded.game_date, tipoff_at = excluded.tipoff_at,
                 home_team_abbr = excluded.home_team_abbr, away_team_abbr = excluded.away_team_abbr,
                 home_score = excluded.home_score, away_score = excluded.away_score,
                 status = excluded.status, is_playoff = excluded.is_playoff,
                 last_synced_at = now()
          returning 1
        )
        select count(*) into v_slate_games from up;
        v_games := v_games + v_slate_games;
        v_per_date := v_per_date || jsonb_build_object(q.slate_date::text,
                        jsonb_build_object('games', v_slate_games));

      else  -- projections
        if jsonb_typeof(v_body->'players') is distinct from 'array' then
          raise exception 'espn kona 200 without players[]: %', left(q.content, 160);
        end if;
        v_proj_ok := true;

        for r in
          with src as (
            select pl->>'id' as espn_id,
                   pl->>'fullName' as full_name,
                   public.nba_espn_team_abbr((pl->>'proTeamId')::int) as team_abbr,
                   nullif(pl->>'injuryStatus', '') as injury,
                   case (pl->>'defaultPositionId')::int
                     when 1 then 'PG' when 2 then 'SG' when 3 then 'SF' when 4 then 'PF' when 5 then 'C'
                   end as position,
                   st->'averageStats' as av
              from jsonb_array_elements(v_body->'players') p
              cross join lateral (select p->'player' as pl) x
              cross join lateral jsonb_array_elements(pl->'stats') st
             where st->>'statSourceId' = '1'
               and st->>'statSplitTypeId' = '0'
               and (st->>'seasonId')::int = q.season_id
               and jsonb_typeof(st->'averageStats') = 'object'
               and st->'averageStats' ?& array['0', '3', '6']   -- PTS, AST, REB present, else skip (never score a missing stat as 0)
          )
          select s.*, g.id as game_id, g.game_date
            from src s
            join public.nba_games g
              on g.game_date in (v_today, v_today + 1)
             and g.external_game_id ~ '^4[0-9]{8}$'          -- ESPN event ids only
             and s.team_abbr in (g.home_team_abbr, g.away_team_abbr)
        loop
          v_found := v_found + 1;

          -- resolve the person: espn_id, then normalized name, then alias, else create
          select id into v_pid from public.nba_players where espn_id = r.espn_id;
          if v_pid is null then
            select coalesce(np.id, npa.nba_player_id) into v_pid
              from (select public.normalize_player_name(r.full_name) as n) k
              left join public.nba_players np on np.full_name_normalized = k.n
              left join public.nba_player_aliases npa on npa.alias_normalized = k.n
             limit 1;
            if v_pid is not null then
              if exists (select 1 from public.nba_players
                          where id = v_pid and espn_id is not null and espn_id <> r.espn_id) then
                v_conflicts := v_conflicts + 1;   -- same name, different ESPN person: never merge
                continue;
              end if;
              update public.nba_players set espn_id = r.espn_id where id = v_pid and espn_id is null;
              v_matched := v_matched + 1;
            else
              insert into public.nba_players
                (full_name, full_name_normalized, current_team_abbr, position, is_active_2026,
                 headshot_url, espn_id, last_synced_at)
              values (r.full_name, public.normalize_player_name(r.full_name), r.team_abbr, r.position, true,
                      'https://a.espncdn.com/i/headshots/nba/players/full/' || r.espn_id || '.png',
                      r.espn_id, now())
              on conflict (full_name_normalized) do nothing
              returning id into v_pid;
              if v_pid is null then
                v_conflicts := v_conflicts + 1;
                continue;
              end if;
              v_inserted := v_inserted + 1;
            end if;
          end if;

          update public.nba_players
             set current_team_abbr = r.team_abbr,
                 position = coalesce(position, r.position),
                 headshot_url = coalesce(headshot_url,
                   'https://a.espncdn.com/i/headshots/nba/players/full/' || r.espn_id || '.png'),
                 is_active_2026 = true,
                 last_synced_at = now()
           where id = v_pid;

          select count(*) into v_ten
            from unnest(array[(r.av->>'0')::numeric, (r.av->>'6')::numeric, (r.av->>'3')::numeric,
                              (r.av->>'2')::numeric, (r.av->>'1')::numeric]) x(v)
           where v >= 10;
          v_fp := round(
                    coalesce((r.av->>'0')::numeric, 0)
                  + 0.5  * coalesce((r.av->>'17')::numeric, 0)
                  + 1.25 * coalesce((r.av->>'6')::numeric, 0)
                  + 1.5  * coalesce((r.av->>'3')::numeric, 0)
                  + 2    * coalesce((r.av->>'2')::numeric, 0)
                  + 2    * coalesce((r.av->>'1')::numeric, 0)
                  - 0.5  * coalesce((r.av->>'11')::numeric, 0)
                  + case when v_ten >= 2 then 1.5 else 0 end
                  + case when v_ten >= 3 then 3 else 0 end, 2);

          insert into public.nba_player_projections as pp
            (nba_player_id, game_id, game_date, proj_points, proj_rebounds, proj_assists, proj_threes,
             proj_steals, proj_blocks, proj_turnovers, proj_minutes, proj_fp_dk, injury_status,
             confidence, source, projection_method, last_synced_at)
          values (v_pid, r.game_id, r.game_date,
                  round((r.av->>'0')::numeric, 2),  round((r.av->>'6')::numeric, 2),
                  round((r.av->>'3')::numeric, 2),  round((r.av->>'17')::numeric, 2),
                  round((r.av->>'2')::numeric, 2),  round((r.av->>'1')::numeric, 2),
                  round((r.av->>'11')::numeric, 2), round((r.av->>'40')::numeric, 2),
                  v_fp, r.injury, 'LOW', 'espn', 'espn-season-projection-v1', now())
          on conflict (nba_player_id, game_id, source) do update
             set proj_points = excluded.proj_points, proj_rebounds = excluded.proj_rebounds,
                 proj_assists = excluded.proj_assists, proj_threes = excluded.proj_threes,
                 proj_steals = excluded.proj_steals, proj_blocks = excluded.proj_blocks,
                 proj_turnovers = excluded.proj_turnovers, proj_minutes = excluded.proj_minutes,
                 proj_fp_dk = excluded.proj_fp_dk, injury_status = excluded.injury_status,
                 confidence = excluded.confidence, projection_method = excluded.projection_method,
                 game_date = excluded.game_date, last_synced_at = now();
          v_written := v_written + 1;
          if exists (select 1 from public.nba_player_projections
                      where nba_player_id = v_pid and game_id = r.game_id and source = 'espn'
                        and proj_fp_dk is null) then
            v_superseded := v_superseded + 1;
          end if;
          v_pid := null;
        end loop;
      end if;

      update public.nba_espn_requests
         set drained_at = now(), outcome = jsonb_build_object('ok', true)
       where request_id = q.request_id;

    exception when query_canceled or others then
      get stacked diagnostics v_err_text = message_text;
      v_errs := v_errs + 1;
      if q.kind = 'projections' then v_proj_ok := false; end if;
      update public.nba_espn_requests
         set drained_at = now(), outcome = jsonb_build_object('ok', false, 'error', left(v_err_text, 300))
       where request_id = q.request_id;
      v_error := coalesce(v_error || ' | ', '') || left(v_err_text, 200);
    end;
  end loop;

  if v_reqs = 0 then
    return jsonb_build_object('drained', 0);
  end if;

  -- per-date projection counts (the #8 rule: judge by rows for today's games, not by ok)
  select v_per_date || coalesce(jsonb_object_agg(d::text, jsonb_build_object(
           'games', (select count(*) from public.nba_games g
                      where g.game_date = d and g.external_game_id ~ '^4[0-9]{8}$'),
           'espn_rankable', (select count(*) from public.nba_player_projections p
                              where p.game_date = d and p.source = 'espn' and p.proj_fp_dk is not null))),
         '{}'::jsonb)
    into v_per_date
    from unnest(array[v_today, v_today + 1]) d;

  v_ok := v_errs = 0;
  if v_proj_ok and v_written = 0
     and exists (select 1 from public.nba_games g
                  where g.game_date = v_today and g.external_game_id ~ '^4[0-9]{8}$') then
    v_ok := false;
    v_error := coalesce(v_error || ' | ', '') || 'zero_projections_with_games_today';
  end if;

  perform public.log_pipeline_run(
    'nba-espn-projections', v_started, v_found, v_written, v_conflicts, v_ok, v_error,
    null, null, null,
    jsonb_build_object('requests', v_reqs, 'request_errors', v_errs, 'games_upserted', v_games,
                       'players_inserted', v_inserted, 'players_matched_by_name', v_matched,
                       'name_conflicts', v_conflicts, 'superseded_by_other_source', v_superseded,
                       'projections_response', v_proj_ok, 'per_date', v_per_date,
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('ok', v_ok, 'requests', v_reqs, 'games', v_games, 'found', v_found,
                            'written', v_written, 'inserted_players', v_inserted,
                            'conflicts', v_conflicts, 'superseded', v_superseded,
                            'per_date', v_per_date, 'error', v_error);
end
$$;

revoke execute on function public.nba_espn_drain() from public, anon, authenticated;
revoke execute on function public.nba_projection_single_rankable() from public, anon, authenticated;
revoke execute on function public.nba_projection_source_rank(text) from public, anon, authenticated;

-- The drain now SKIPS a player missing PTS/AST/REB, so rows written by the first tick for such a
-- player would never be rewritten. Unrank them once (Essengue, 10-23 and 10-24).
update public.nba_player_projections
   set proj_fp_dk = null
 where source = 'espn'
   and proj_fp_dk is not null
   and (proj_points is null or proj_assists is null or proj_rebounds is null);
