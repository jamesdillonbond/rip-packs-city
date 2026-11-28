-- audit_20261127_nba_projections_blend_season_form
--
-- Trevor 2026-11-27 ("Yes do it all" / "Go"). Follows 20261128050200 (box scores).
-- ESPN's "season projection" is a preseason number that never moves (all 277 players checked
-- had the identical value every night 11-20..11-26). Walk-forward backtest 11-01..11-26 on the
-- stored box scores, predicting each game only from games BEFORE it (3,221 player-games):
--   DK-FP MAE    ESPN 8.78 · season-to-date avg 7.72 · blend k=3 7.72 (k=5 7.79, k=10 7.96)
--   stars (ESPN >= 30 FP, 1,036 games): ESPN 9.44 -> blend 8.68
--   nightly top-10 overlap with actual top-10: 5.12 -> 5.48; top-25 14.96 -> 15.96 (25 nights)
--   points MAE 5.22 -> 4.72 · 3PM 1.054 -> 0.993 (k=5) · rebounds 2.10 -> 1.95 (k=5)
-- So every projected stat is now (3 * ESPN + n * season-to-date actual) / (3 + n), n = games
-- played this season before the projected game; projection_method gets '+form-k3'.
-- Revert: re-apply the nba_espn_drain body from 20261128050200; drop function public.nba_blend.

create or replace function public.nba_blend(p_espn numeric, p_actual numeric, p_n numeric)
returns numeric
language sql immutable parallel safe
set search_path to 'pg_catalog'
as $$
  select case when p_espn is null then p_actual
              when p_actual is null or coalesce(p_n, 0) = 0 then p_espn
              else (3 * p_espn + p_n * p_actual) / (3 + p_n) end
$$;
-- anon-exec: revoked (nba_blend) — new pure helper for the lane only.
revoke execute on function public.nba_blend(numeric, numeric, numeric) from public, anon, authenticated;

create or replace function public.nba_espn_drain()
 returns jsonb
 language plpgsql
 set search_path to 'pg_catalog', 'public'
as $function$
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
  v_actual_fallback int := 0;
  v_inserted  int := 0;
  v_matched   int := 0;
  v_conflicts int := 0;
  v_superseded int := 0;
  v_unseen    int := 0;
  v_box_games int := 0;
  v_box_rows  int := 0;
  v_prev_rank int;
  v_proj_ok   boolean := null;   -- null = no projections response this tick
  v_slate_games int;
  v_pid       uuid;
  v_outcome   text;
  f           record;
  v_fp        numeric;
  v_per_date  jsonb := '{}'::jsonb;
  v_ok        boolean;
  v_error     text;
begin
  if not pg_try_advisory_xact_lock(hashtext('nba_espn_drain')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  for q in
    select a.request_id, a.kind, a.slate_date, a.season_id, a.game_id,
           r0.status_code, r0.content, r0.error_msg, r0.timed_out
      from public.nba_espn_requests a
      left join net._http_response r0 on r0.id = a.request_id
     where a.drained_at is null
       and (r0.id is not null or a.dispatched_at < now() - interval '10 minutes')
     order by (a.kind = 'projections'), a.dispatched_at   -- scoreboards and box scores before projections
     limit 40
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

      elsif q.kind = 'boxscore' then
        if jsonb_typeof(v_body->'boxscore'->'players') is distinct from 'array'
           or jsonb_array_length(v_body->'boxscore'->'players') <> 2 then
          raise exception 'espn summary 200 without two boxscore teams: %', left(q.content, 160);
        end if;
        for r in
          select a->'athlete'->>'id'          as espn_id,
                 a->'athlete'->>'displayName' as full_name,
                 a->'athlete'->'position'->>'abbreviation' as position,
                 public.nba_espn_team_abbr((t->'team'->>'id')::int) as team_abbr,
                 (a->>'starter')::boolean     as starter,
                 coalesce((a->>'didNotPlay')::boolean, false) as dnp,
                 nullif(a->>'reason', '')     as reason,
                 -- keys[] ↔ stats[] as one object, so a reordered feed cannot shift columns
                 (select jsonb_object_agg(k.key, a->'stats'->>(k.ord::int - 1))
                    from jsonb_array_elements_text(t->'statistics'->0->'keys') with ordinality k(key, ord)) as st
            from jsonb_array_elements(v_body->'boxscore'->'players') t
            cross join lateral jsonb_array_elements(t->'statistics'->0->'athletes') a
           where a->'athlete'->>'id' is not null
        loop
          select x.player_id, x.outcome into v_pid, v_outcome
            from public.nba_resolve_espn_player(r.espn_id, r.full_name, r.team_abbr, r.position) x;
          if v_outcome = 'inserted' then v_inserted := v_inserted + 1;
          elsif v_outcome = 'matched_by_name' then v_matched := v_matched + 1;
          elsif v_outcome = 'conflict' then v_conflicts := v_conflicts + 1;
          end if;

          insert into public.nba_player_game_stats as s
            (game_id, espn_athlete_id, nba_player_id, game_date, player_name, team_abbr, starter,
             did_play, dnp_reason, minutes, pts, reb, ast, stl, blk, tov,
             fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, pf, plus_minus, synced_at)
          select q.game_id, r.espn_id, v_pid, q.slate_date, r.full_name, r.team_abbr, r.starter,
                 played, case when played then null else coalesce(r.reason, 'DNP') end,
                 case when played then public.nba_box_num(r.st->>'minutes') end,
                 case when played then public.nba_box_num(r.st->>'points') end,
                 case when played then public.nba_box_num(r.st->>'rebounds') end,
                 case when played then public.nba_box_num(r.st->>'assists') end,
                 case when played then public.nba_box_num(r.st->>'steals') end,
                 case when played then public.nba_box_num(r.st->>'blocks') end,
                 case when played then public.nba_box_num(r.st->>'turnovers') end,
                 case when played then public.nba_box_num(split_part(r.st->>'fieldGoalsMade-fieldGoalsAttempted', '-', 1)) end,
                 case when played then public.nba_box_num(split_part(r.st->>'fieldGoalsMade-fieldGoalsAttempted', '-', 2)) end,
                 case when played then public.nba_box_num(split_part(r.st->>'threePointFieldGoalsMade-threePointFieldGoalsAttempted', '-', 1)) end,
                 case when played then public.nba_box_num(split_part(r.st->>'threePointFieldGoalsMade-threePointFieldGoalsAttempted', '-', 2)) end,
                 case when played then public.nba_box_num(split_part(r.st->>'freeThrowsMade-freeThrowsAttempted', '-', 1)) end,
                 case when played then public.nba_box_num(split_part(r.st->>'freeThrowsMade-freeThrowsAttempted', '-', 2)) end,
                 case when played then public.nba_box_num(r.st->>'offensiveRebounds') end,
                 case when played then public.nba_box_num(r.st->>'defensiveRebounds') end,
                 case when played then public.nba_box_num(r.st->>'fouls') end,
                 case when played then public.nba_box_num(replace(r.st->>'plusMinus', '+', '')) end,
                 now()
            from (select not r.dnp
                         and coalesce(r.st->>'minutes', '') ~ '^[0-9]+$'
                         and coalesce(r.st->>'points', '') ~ '^[0-9]+$' as played) p
          on conflict (game_id, espn_athlete_id) do update
             set nba_player_id = excluded.nba_player_id, game_date = excluded.game_date,
                 player_name = excluded.player_name, team_abbr = excluded.team_abbr,
                 starter = excluded.starter, did_play = excluded.did_play,
                 dnp_reason = excluded.dnp_reason, minutes = excluded.minutes,
                 pts = excluded.pts, reb = excluded.reb, ast = excluded.ast, stl = excluded.stl,
                 blk = excluded.blk, tov = excluded.tov, fgm = excluded.fgm, fga = excluded.fga,
                 fg3m = excluded.fg3m, fg3a = excluded.fg3a, ftm = excluded.ftm, fta = excluded.fta,
                 oreb = excluded.oreb, dreb = excluded.dreb, pf = excluded.pf,
                 plus_minus = excluded.plus_minus, synced_at = now();
          v_box_rows := v_box_rows + 1;
          v_pid := null; v_outcome := null;
        end loop;
        v_box_games := v_box_games + 1;

      else  -- projections
        if jsonb_typeof(v_body->'players') is distinct from 'array' then
          raise exception 'espn kona 200 without players[]: %', left(q.content, 160);
        end if;
        v_proj_ok := true;

        for r in
          with src as (
            -- ESPN's season projection (statSourceId 1) when it has one; otherwise the
            -- player's actual season averages (statSourceId 0) — rookies ESPN has not
            -- projected were dropped entirely before 2026-11-27.
            select distinct on (pl->>'id')
                   pl->>'id' as espn_id,
                   pl->>'fullName' as full_name,
                   public.nba_espn_team_abbr((pl->>'proTeamId')::int) as team_abbr,
                   nullif(pl->>'injuryStatus', '') as injury,
                   case (pl->>'defaultPositionId')::int
                     when 1 then 'PG' when 2 then 'SG' when 3 then 'SF' when 4 then 'PF' when 5 then 'C'
                   end as position,
                   st->'averageStats' as av,
                   st->>'statSourceId' = '1' as is_projection
              from jsonb_array_elements(v_body->'players') p
              cross join lateral (select p->'player' as pl) x
              cross join lateral jsonb_array_elements(pl->'stats') st
             where st->>'statSourceId' in ('0', '1')
               and st->>'statSplitTypeId' = '0'
               and (st->>'seasonId')::int = q.season_id
               and jsonb_typeof(st->'averageStats') = 'object'
               and st->'averageStats' ?& array['0', '3', '6']   -- PTS, AST, REB present, else skip (never score a missing stat as 0)
             order by pl->>'id', (st->>'statSourceId' = '1') desc
          )
          select s.*, g.id as game_id, g.game_date
            from src s
            join public.nba_games g
              on g.game_date in (v_today, v_today + 1)
             and g.external_game_id ~ '^4[0-9]{8}$'          -- ESPN event ids only
             and s.team_abbr in (g.home_team_abbr, g.away_team_abbr)
        loop
          v_found := v_found + 1;

          select x.player_id, x.outcome into v_pid, v_outcome
            from public.nba_resolve_espn_player(r.espn_id, r.full_name, r.team_abbr, r.position) x;
          if v_outcome = 'conflict' then v_conflicts := v_conflicts + 1; continue; end if;
          if v_outcome = 'inserted' then v_inserted := v_inserted + 1;
          elsif v_outcome = 'matched_by_name' then v_matched := v_matched + 1;
          end if;

          update public.nba_players
             set current_team_abbr = r.team_abbr,
                 position = coalesce(position, r.position),
                 headshot_url = coalesce(headshot_url,
                   'https://a.espncdn.com/i/headshots/nba/players/full/' || r.espn_id || '.png'),
                 is_active_2026 = true,
                 last_synced_at = now()
           where id = v_pid;

          -- season-to-date form from stored box scores (games BEFORE this one), blended with
          -- ESPN's season number at weight 3 games: (3*espn + n*actual)/(3+n).
          select count(*)::numeric as n,
                 avg(s.pts) as pts, avg(s.reb) as reb, avg(s.ast) as ast, avg(s.stl) as stl,
                 avg(s.blk) as blk, avg(s.tov) as tov, avg(s.fg3m) as fg3m, avg(s.fg3a) as fg3a,
                 avg(s.fgm) as fgm, avg(s.fga) as fga, avg(s.ftm) as ftm, avg(s.fta) as fta,
                 avg(s.minutes) as mins
            into f
            from public.nba_player_game_stats s
           where s.nba_player_id = v_pid and s.did_play
             and s.game_date < r.game_date
             and s.game_date >= make_date(q.season_id - 1, 10, 1);

          v_fp := public.nba_dk_fp(
                    coalesce(public.nba_blend((r.av->>'0')::numeric,  f.pts,  f.n), 0),
                    coalesce(public.nba_blend((r.av->>'17')::numeric, f.fg3m, f.n), 0),
                    coalesce(public.nba_blend((r.av->>'6')::numeric,  f.reb,  f.n), 0),
                    coalesce(public.nba_blend((r.av->>'3')::numeric,  f.ast,  f.n), 0),
                    coalesce(public.nba_blend((r.av->>'2')::numeric,  f.stl,  f.n), 0),
                    coalesce(public.nba_blend((r.av->>'1')::numeric,  f.blk,  f.n), 0),
                    coalesce(public.nba_blend((r.av->>'11')::numeric, f.tov,  f.n), 0));
          if not r.is_projection then v_actual_fallback := v_actual_fallback + 1; end if;

          insert into public.nba_player_projections as pp
            (nba_player_id, game_id, game_date, proj_points, proj_rebounds, proj_assists, proj_threes,
             proj_three_attempts, proj_fgm, proj_fga, proj_ftm, proj_fta,
             proj_steals, proj_blocks, proj_turnovers, proj_minutes, proj_fp_dk, injury_status,
             confidence, source, projection_method, last_synced_at)
          values (v_pid, r.game_id, r.game_date,
                  round(public.nba_blend((r.av->>'0')::numeric, f.pts, f.n), 2),
                  round(public.nba_blend((r.av->>'6')::numeric, f.reb, f.n), 2),
                  round(public.nba_blend((r.av->>'3')::numeric, f.ast, f.n), 2),
                  round(public.nba_blend((r.av->>'17')::numeric, f.fg3m, f.n), 2),
                  round(public.nba_blend((r.av->>'18')::numeric, f.fg3a, f.n), 2),
                  round(public.nba_blend((r.av->>'13')::numeric, f.fgm, f.n), 2),
                  round(public.nba_blend((r.av->>'14')::numeric, f.fga, f.n), 2),
                  round(public.nba_blend((r.av->>'15')::numeric, f.ftm, f.n), 2),
                  round(public.nba_blend((r.av->>'16')::numeric, f.fta, f.n), 2),
                  round(public.nba_blend((r.av->>'2')::numeric, f.stl, f.n), 2),
                  round(public.nba_blend((r.av->>'1')::numeric, f.blk, f.n), 2),
                  round(public.nba_blend((r.av->>'11')::numeric, f.tov, f.n), 2),
                  round(public.nba_blend((r.av->>'40')::numeric, f.mins, f.n), 2),
                  v_fp, r.injury, 'LOW', 'espn',
                  case when r.is_projection then 'espn-season-projection-v1' else 'espn-season-actual-v1' end
                    || case when f.n > 0 then '+form-k3' else '' end,
                  now())
          on conflict (nba_player_id, game_id, source) do update
             set proj_points = excluded.proj_points, proj_rebounds = excluded.proj_rebounds,
                 proj_assists = excluded.proj_assists, proj_threes = excluded.proj_threes,
                 proj_three_attempts = excluded.proj_three_attempts,
                 proj_fgm = excluded.proj_fgm, proj_fga = excluded.proj_fga,
                 proj_ftm = excluded.proj_ftm, proj_fta = excluded.proj_fta,
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
          v_pid := null; v_outcome := null;
        end loop;

        -- A player ESPN stopped projecting keeps yesterday's row unless it is unranked here. Only on
        -- a tick that looks complete: >= 100 written AND >= 80 % of
        -- the rankable rows now held (this tick's plus stale ones), so a short or partial ESPN
        -- response can never empty the board.
        select count(*) into v_prev_rank
          from public.nba_player_projections
         where source = 'espn' and game_date in (v_today, v_today + 1) and proj_fp_dk is not null;
        if v_written >= 100 and v_written >= 0.8 * v_prev_rank then
          with gone as (
            update public.nba_player_projections
               set proj_fp_dk = null
             where source = 'espn'
               and game_date in (v_today, v_today + 1)
               and proj_fp_dk is not null
               and last_synced_at < now()   -- rows rewritten this tick carry now() (txn start); clock_timestamp() would match them too
            returning 1)
          select count(*) into v_unseen from gone;
        end if;
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
                       'unranked_not_seen_this_tick', v_unseen,
                       'season_actual_fallback', v_actual_fallback,
                       'boxscore_games', v_box_games, 'boxscore_rows', v_box_rows,
                       'projections_response', v_proj_ok, 'per_date', v_per_date,
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('ok', v_ok, 'requests', v_reqs, 'games', v_games, 'found', v_found,
                            'written', v_written, 'season_actual_fallback', v_actual_fallback,
                            'inserted_players', v_inserted,
                            'conflicts', v_conflicts, 'superseded', v_superseded, 'unseen', v_unseen,
                            'boxscore_games', v_box_games, 'boxscore_rows', v_box_rows,
                            'per_date', v_per_date, 'error', v_error);
end
$function$;
-- anon-exec: unchanged (nba_espn_drain) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified anon=false.
