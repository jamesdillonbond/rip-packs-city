-- audit_20261127_nba_box_scores_and_fast_break_nights
--
-- Trevor 2026-11-27 8:43 PM PT ("Yes do it all"), after the Fast Break in-season QA
-- (claude/fast-break-qa-2026-11-27.md):
--   1. Box scores are stored nightly (nba_player_game_stats), so lineups can be scored
--      and projections backtested. Same pg_net lane as the scoreboard/projections:
--      nba_espn_dispatch() asks ESPN's game summary for every final ESPN game without
--      stats; nba_espn_drain() parses it.
--   2. Players ESPN does not project (mostly 2026 rookies: Aday Mara, Bennett Stirtz,
--      Christian Anderson…) fell out of the feed — the drain required a projection
--      (statSourceId 1). It now falls back to the player's actual season averages
--      (statSourceId 0), method espn-season-actual-v1. The QA found 58 player-games of
--      20+ minutes with no projection in one week.
--   3. Top Shot's regular-season Fast Break scores nightly stat targets (e.g. 11-27:
--      18 3PM + 40 3PA across 5 players), not DK points. 3PA, FGM/FGA and FTM/FTA are
--      now stored on projections, and fast_break_nights holds each night's targets.
--   4. One resolver (nba_resolve_espn_player) for both the projection and box-score paths.
--
-- Revert: see the bottom of this file.

-- nba_espn_requests / nba_player_projections are written hourly by the lane; never queue behind it.
set local lock_timeout = '3s';

-- ── 1. box scores ───────────────────────────────────────────────────────────
create or replace function public.nba_dk_fp(
  p_pts numeric, p_fg3m numeric, p_reb numeric, p_ast numeric,
  p_stl numeric, p_blk numeric, p_tov numeric)
returns numeric
language sql immutable parallel safe
set search_path to 'pg_catalog'
as $$
  select round(
      p_pts + 0.5 * p_fg3m + 1.25 * p_reb + 1.5 * p_ast + 2 * p_stl + 2 * p_blk - 0.5 * p_tov
    + case when ((p_pts >= 10)::int + (p_reb >= 10)::int + (p_ast >= 10)::int
               + (p_stl >= 10)::int + (p_blk >= 10)::int) >= 3 then 4.5
           when ((p_pts >= 10)::int + (p_reb >= 10)::int + (p_ast >= 10)::int
               + (p_stl >= 10)::int + (p_blk >= 10)::int) >= 2 then 1.5
           else 0 end, 2)
$$;
-- anon-exec: revoked (nba_dk_fp) — new pure helper; only the lane and the generated column call it.
revoke execute on function public.nba_dk_fp(numeric, numeric, numeric, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;

create or replace function public.nba_box_num(p text)
returns numeric
language sql immutable parallel safe
set search_path to 'pg_catalog'
as $$ select case when p ~ '^-?[0-9]+(\.[0-9]+)?$' then p::numeric end $$;
-- anon-exec: revoked (nba_box_num) — new pure parse helper for the lane only.
revoke execute on function public.nba_box_num(text) from public, anon, authenticated;

create table if not exists public.nba_player_game_stats (
  game_id          uuid not null references public.nba_games(id) on delete cascade,
  espn_athlete_id  text not null,
  nba_player_id    uuid references public.nba_players(id) on delete set null,
  game_date        date not null,
  player_name      text not null,
  team_abbr        text,
  starter          boolean,
  did_play         boolean not null,
  dnp_reason       text,
  minutes          numeric,
  pts numeric, reb numeric, ast numeric, stl numeric, blk numeric, tov numeric,
  fgm numeric, fga numeric, fg3m numeric, fg3a numeric, ftm numeric, fta numeric,
  oreb numeric, dreb numeric, pf numeric, plus_minus numeric,
  fp_dk numeric generated always as (
    case when did_play then public.nba_dk_fp(pts, fg3m, reb, ast, stl, blk, tov) end) stored,
  synced_at        timestamptz not null default now(),
  primary key (game_id, espn_athlete_id)
);
create index if not exists nba_player_game_stats_player_date_idx
  on public.nba_player_game_stats (nba_player_id, game_date);
create index if not exists nba_player_game_stats_date_idx
  on public.nba_player_game_stats (game_date);
alter table public.nba_player_game_stats enable row level security;
revoke all on public.nba_player_game_stats from anon, authenticated;
grant select on public.nba_player_game_stats to anon, authenticated;
drop policy if exists nba_player_game_stats_read on public.nba_player_game_stats;
create policy nba_player_game_stats_read on public.nba_player_game_stats for select using (true);
comment on table public.nba_player_game_stats is
  'ESPN box scores, one row per player per final game (pg_net lane nba-espn-projections, kind boxscore). '
  'fp_dk = DraftKings classic scoring. 2026-11-27.';

-- ── 2. nightly Fast Break targets ───────────────────────────────────────────
create table if not exists public.fast_break_nights (
  run_id       uuid not null references public.fast_break_runs(id) on delete cascade,
  game_date    date not null,
  objective    text not null,            -- Top Shot's own wording, e.g. 'Combine for 18 3-Pointers Made + 40 3-Pointers Attempted'
  targets      jsonb not null,           -- {"fg3m": 18, "fg3a": 40}; keys = nba_player_game_stats columns
  source       text not null default 'manual',
  created_at   timestamptz not null default now(),
  primary key (run_id, game_date),
  constraint fast_break_nights_targets_object check (jsonb_typeof(targets) = 'object')
);
alter table public.fast_break_nights enable row level security;
revoke all on public.fast_break_nights from anon, authenticated;
grant select on public.fast_break_nights to anon, authenticated;
drop policy if exists fast_break_nights_read on public.fast_break_nights;
create policy fast_break_nights_read on public.fast_break_nights for select using (true);
comment on table public.fast_break_nights is
  'Top Shot Fast Break nightly stat targets per run (regular-season "thresholds" objective). '
  'Recorded by hand from nbatopshot.com/fastbreak; Atlas GetContest needs a user JWT. 2026-11-27.';

-- ── 3. projection columns + request kind ────────────────────────────────────
alter table public.nba_player_projections
  add column if not exists proj_three_attempts numeric,
  add column if not exists proj_fgm numeric,
  add column if not exists proj_fga numeric,
  add column if not exists proj_ftm numeric,
  add column if not exists proj_fta numeric;

alter table public.nba_espn_requests drop constraint if exists nba_espn_requests_kind_check;
alter table public.nba_espn_requests add constraint nba_espn_requests_kind_check
  check (kind = any (array['scoreboard', 'projections', 'boxscore']));
alter table public.nba_espn_requests add column if not exists game_id uuid;

-- ── 4. one resolver ─────────────────────────────────────────────────────────
-- espn_id, then normalized name, then alias, else create. A name held by a DIFFERENT
-- ESPN person is never merged: returns null with outcome 'conflict'.
create or replace function public.nba_resolve_espn_player(
  p_espn_id text, p_full_name text, p_team_abbr text, p_position text,
  out player_id uuid, out outcome text)
language plpgsql
set search_path to 'pg_catalog', 'public'
as $$
begin
  select id into player_id from public.nba_players where espn_id = p_espn_id;
  if player_id is not null then outcome := 'espn_id'; return; end if;

  select coalesce(np.id, npa.nba_player_id) into player_id
    from (select public.normalize_player_name(p_full_name) as n) k
    left join public.nba_players np on np.full_name_normalized = k.n
    left join public.nba_player_aliases npa on npa.alias_normalized = k.n
   limit 1;
  if player_id is not null then
    if exists (select 1 from public.nba_players
                where id = player_id and espn_id is not null and espn_id <> p_espn_id) then
      player_id := null; outcome := 'conflict'; return;
    end if;
    update public.nba_players set espn_id = p_espn_id where id = player_id and espn_id is null;
    outcome := 'matched_by_name'; return;
  end if;

  insert into public.nba_players
    (full_name, full_name_normalized, current_team_abbr, position, is_active_2026,
     headshot_url, espn_id, last_synced_at)
  values (p_full_name, public.normalize_player_name(p_full_name), p_team_abbr, p_position, true,
          'https://a.espncdn.com/i/headshots/nba/players/full/' || p_espn_id || '.png',
          p_espn_id, now())
  on conflict (full_name_normalized) do nothing
  returning id into player_id;
  outcome := case when player_id is null then 'conflict' else 'inserted' end;
end
$$;
-- anon-exec: revoked (nba_resolve_espn_player) — new writer helper for the lane; verified anon=false after apply.
revoke execute on function public.nba_resolve_espn_player(text, text, text, text)
  from public, anon, authenticated;

-- ── 5. dispatch: + box scores ───────────────────────────────────────────────
create or replace function public.nba_espn_dispatch()
 returns jsonb
 language plpgsql
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_today  date := (now() at time zone 'America/Los_Angeles')::date;
  v_season int;
  v_req    bigint;
  v_n      int := 0;
  v_box    int := 0;
  d        date;
  g        record;
begin
  -- one batch in flight; the drain abandons anything older than 10 minutes
  if exists (select 1 from public.nba_espn_requests
              where drained_at is null and dispatched_at > now() - interval '10 minutes') then
    return jsonb_build_object('skipped', 'in_flight');
  end if;

  v_season := extract(year from v_today)::int
              + case when extract(month from v_today) >= 8 then 1 else 0 end;

  foreach d in array array[v_today, v_today + 1] loop
    v_req := net.http_get(
      url := 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates='
             || to_char(d, 'YYYYMMDD'),
      timeout_milliseconds := 20000);
    insert into public.nba_espn_requests (request_id, kind, slate_date, season_id)
    values (v_req, 'scoreboard', d, v_season);
    v_n := v_n + 1;
  end loop;

  v_req := net.http_get(
    url := 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/' || v_season
           || '/segments/0/leaguedefaults/1?view=kona_player_info',
    headers := jsonb_build_object('X-Fantasy-Filter',
      '{"players":{"limit":1000,"filterStatsForTopScoringPeriodIds":{"value":2,"additionalValue":["10'
      || v_season || '","00' || v_season || '"]},"sortPercOwned":{"sortPriority":1,"sortAsc":false}}}'),
    timeout_milliseconds := 30000);
  insert into public.nba_espn_requests (request_id, kind, slate_date, season_id)
  values (v_req, 'projections', v_today, v_season);
  v_n := v_n + 1;

  -- box scores: final ESPN games of the last 3 days with no stats yet, at most 12 a tick,
  -- each asked at most once an hour (a game whose summary keeps failing is not hammered).
  for g in
    select ng.id, ng.external_game_id, ng.game_date
      from public.nba_games ng
     where ng.status = 'final'
       and ng.external_game_id ~ '^4[0-9]{8}$'
       and ng.game_date between v_today - 3 and v_today
       and not exists (select 1 from public.nba_player_game_stats s where s.game_id = ng.id)
       and not exists (select 1 from public.nba_espn_requests r
                        where r.kind = 'boxscore' and r.game_id = ng.id
                          and r.dispatched_at > now() - interval '55 minutes')
     order by ng.game_date, ng.tipoff_at
     limit 12
  loop
    v_req := net.http_get(
      url := 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event='
             || g.external_game_id,
      timeout_milliseconds := 20000);
    insert into public.nba_espn_requests (request_id, kind, slate_date, season_id, game_id)
    values (v_req, 'boxscore', g.game_date, v_season, g.id);
    v_box := v_box + 1;
  end loop;

  return jsonb_build_object('dispatched', v_n + v_box, 'boxscores', v_box,
                            'season', v_season, 'today', v_today);
end
$function$;
-- anon-exec: unchanged (nba_espn_dispatch) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified anon=false.

-- ── 6. drain: + box scores, + season-actual fallback, + new stat columns ─────
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

          v_fp := public.nba_dk_fp(
                    coalesce((r.av->>'0')::numeric, 0),  coalesce((r.av->>'17')::numeric, 0),
                    coalesce((r.av->>'6')::numeric, 0),  coalesce((r.av->>'3')::numeric, 0),
                    coalesce((r.av->>'2')::numeric, 0),  coalesce((r.av->>'1')::numeric, 0),
                    coalesce((r.av->>'11')::numeric, 0));
          if not r.is_projection then v_actual_fallback := v_actual_fallback + 1; end if;

          insert into public.nba_player_projections as pp
            (nba_player_id, game_id, game_date, proj_points, proj_rebounds, proj_assists, proj_threes,
             proj_three_attempts, proj_fgm, proj_fga, proj_ftm, proj_fta,
             proj_steals, proj_blocks, proj_turnovers, proj_minutes, proj_fp_dk, injury_status,
             confidence, source, projection_method, last_synced_at)
          values (v_pid, r.game_id, r.game_date,
                  round((r.av->>'0')::numeric, 2),  round((r.av->>'6')::numeric, 2),
                  round((r.av->>'3')::numeric, 2),  round((r.av->>'17')::numeric, 2),
                  round((r.av->>'18')::numeric, 2),
                  round((r.av->>'13')::numeric, 2), round((r.av->>'14')::numeric, 2),
                  round((r.av->>'15')::numeric, 2), round((r.av->>'16')::numeric, 2),
                  round((r.av->>'2')::numeric, 2),  round((r.av->>'1')::numeric, 2),
                  round((r.av->>'11')::numeric, 2), round((r.av->>'40')::numeric, 2),
                  v_fp, r.injury, 'LOW', 'espn',
                  case when r.is_projection then 'espn-season-projection-v1' else 'espn-season-actual-v1' end,
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

-- Revert:
--   restore nba_espn_dispatch / nba_espn_drain from 20261023171729_audit_20261023_nba_espn_projections_unrank_unseen.sql
--   (and earlier lane files) — the bodies before this file;
--   drop function public.nba_resolve_espn_player(text, text, text, text);
--   drop table public.fast_break_nights; drop table public.nba_player_game_stats;
--   drop function public.nba_dk_fp(numeric, numeric, numeric, numeric, numeric, numeric, numeric);
--   alter table public.nba_player_projections drop column proj_three_attempts, drop column proj_fgm,
--     drop column proj_fga, drop column proj_ftm, drop column proj_fta;
--   delete from public.nba_espn_requests where kind = 'boxscore';
--   alter table public.nba_espn_requests drop column game_id; restore kind check to ('scoreboard','projections').
