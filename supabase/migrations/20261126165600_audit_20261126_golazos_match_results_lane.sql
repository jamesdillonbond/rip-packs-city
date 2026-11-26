-- audit_20261126_golazos_match_results_lane
--
-- The Moment slab's back for LaLiga Golazos: the match result. Golazos editions carry their match date,
-- both clubs and the player's club (575 editions, 316 dates, 2005-08-28 .. 2023-06-04, measured 2026-11-26),
-- but no ESPN player link — and the per-athlete game log is not needed: ESPN's LaLiga scoreboard for the
-- date names both clubs and the final score (probed 11-26 from pg_net: 2021-10-24 → Barcelona 1-2 Real
-- Madrid, completed). espn_game_events (the box-score lane) starts 2026-08-14 and carries no names or
-- scores, so it cannot serve these.
--
--   espn_soccer_scoreboard_fetches — one row per (league, date): requested → ok | error (≤ 3 attempts)
--   espn_soccer_matches            — one row per ESPN event: both clubs, the score, completed
--   soccer_club_tokens(text)       — a club name as comparable tokens ("Atlético de Madrid" and
--                                    "Atlético Madrid" → {atletico, madrid}; "Elche CF" → {elche})
--   espn_soccer_scoreboard_dispatch() pg_cron :07,:27,:47 — ≤ 40 unfetched Golazos dates per run
--   espn_soccer_scoreboard_drain()    pg_cron :09,:29,:49 — parse, upsert, log_pipeline_run('golazos-match-results')
--
-- Revert:
--   select cron.unschedule('rpc-golazos-scoreboard-dispatch'); select cron.unschedule('rpc-golazos-scoreboard-drain');
--   delete from public.pipeline_cadence_watchlist where pipeline = 'golazos-match-results';
--   drop function public.espn_soccer_scoreboard_drain(); drop function public.espn_soccer_scoreboard_dispatch(int);
--   drop function public.soccer_club_tokens(text);
--   drop table public.espn_soccer_matches; drop table public.espn_soccer_scoreboard_fetches;

create table public.espn_soccer_scoreboard_fetches (
  league       text not null,
  match_date   date not null,
  status       text not null check (status in ('requested', 'ok', 'error')),
  request_id   bigint,
  requested_at timestamptz,
  fetched_at   timestamptz,
  attempts     int not null default 0,
  events       int,
  last_error   text,
  primary key (league, match_date)
);

create table public.espn_soccer_matches (
  league       text not null,
  event_id     text not null,
  match_date   date not null,
  kickoff      timestamptz,
  home_name    text,
  away_name    text,
  home_score   int,
  away_score   int,
  completed    boolean,
  refreshed_at timestamptz not null default now(),
  primary key (league, event_id)
);
create index espn_soccer_matches_date_idx on public.espn_soccer_matches (league, match_date);

alter table public.espn_soccer_scoreboard_fetches enable row level security;
alter table public.espn_soccer_matches enable row level security;
revoke all on public.espn_soccer_scoreboard_fetches, public.espn_soccer_matches from public, anon, authenticated;
grant all on public.espn_soccer_scoreboard_fetches, public.espn_soccer_matches to service_role;

-- A club name as tokens: accents folded, lower case, legal/club words dropped ("FC", "CF", "RCD", "de"…).
-- "Real" is kept — it is what tells Real Madrid from Atlético de Madrid.
CREATE OR REPLACE FUNCTION public.soccer_club_tokens(p_name text)
returns text[]
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(t order by t), '{}'::text[])
    from regexp_split_to_table(lower(extensions.unaccent(coalesce(p_name, ''))), '[^a-z0-9]+') t
   where t <> ''
     and length(t) > 1
     and t not in ('fc', 'cf', 'cd', 'ud', 'sd', 'rcd', 'rc', 'ca', 'cp', 'club', 'de', 'la', 'del', 'el', 'sad', 'balompie', 'futbol')
$$;
-- anon-exec: revoked (soccer_club_tokens) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.soccer_club_tokens(text) from public, anon, authenticated;
grant execute on function public.soccer_club_tokens(text) to postgres, service_role;

CREATE OR REPLACE FUNCTION public.espn_soccer_scoreboard_dispatch(p_limit int default 40)
returns int
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  r     record;
  v_req bigint;
  v_n   int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_soccer_scoreboard_dispatch')::bigint) then
    return 0;
  end if;
  for r in
    select d.match_date
      from (select distinct e.game_date as match_date
              from public.editions e
              join public.collections c on c.id = e.collection_id and c.slug = 'laliga_golazos'
             where e.game_date is not null) d
      left join public.espn_soccer_scoreboard_fetches f on f.league = 'esp.1' and f.match_date = d.match_date
     where f.match_date is null
        or (f.status = 'error' and f.attempts < 3 and coalesce(f.fetched_at, f.requested_at) < now() - interval '1 hour')
        or (f.status = 'requested' and f.attempts < 3 and f.requested_at < now() - interval '1 hour')
     order by d.match_date desc
     limit greatest(1, least(coalesce(p_limit, 40), 100))
  loop
    v_req := net.http_get('https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard?dates=' || to_char(r.match_date, 'YYYYMMDD'));
    insert into public.espn_soccer_scoreboard_fetches as f (league, match_date, status, request_id, requested_at, attempts)
    values ('esp.1', r.match_date, 'requested', v_req, now(), 1)
    on conflict (league, match_date) do update
       set status = 'requested', request_id = excluded.request_id, requested_at = now(), attempts = f.attempts + 1;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
-- anon-exec: revoked (espn_soccer_scoreboard_dispatch) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_soccer_scoreboard_dispatch(int) from public, anon, authenticated;
grant execute on function public.espn_soccer_scoreboard_dispatch(int) to postgres, service_role;

CREATE OR REPLACE FUNCTION public.espn_soccer_scoreboard_drain()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_started  timestamptz := clock_timestamp();
  q          record;
  v_body     jsonb;
  v_kept     int;
  v_reqs     int := 0;
  v_errs     int := 0;
  v_rows     int := 0;
  v_err_text text;
  v_error    text;
  v_ok       boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_soccer_scoreboard_drain')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  for q in
    select f.league, f.match_date, f.request_id, r0.status_code, r0.content, r0.error_msg, r0.timed_out
      from public.espn_soccer_scoreboard_fetches f
      left join net._http_response r0 on r0.id = f.request_id
     where f.status = 'requested'
       and (r0.id is not null or f.requested_at < now() - interval '10 minutes')
     order by f.requested_at
     limit 60
  loop
    v_reqs := v_reqs + 1;
    begin
      if q.status_code is null or q.status_code <> 200 or q.timed_out then
        raise exception 'espn scoreboard % % (%): %', q.league, q.match_date, coalesce(q.status_code::text, 'no-response'),
          left(coalesce(q.error_msg, q.content, ''), 120);
      end if;
      v_body := q.content::jsonb;
      if jsonb_typeof(v_body->'events') <> 'array' then
        raise exception 'espn scoreboard % %: no events array', q.league, q.match_date;
      end if;

      insert into public.espn_soccer_matches as m
        (league, event_id, match_date, kickoff, home_name, away_name, home_score, away_score, completed, refreshed_at)
      select q.league, ev->>'id', q.match_date, (ev->>'date')::timestamptz,
             (select c->'team'->>'displayName' from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'home' limit 1),
             (select c->'team'->>'displayName' from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'away' limit 1),
             (select nullif(c->>'score', '')::int from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'home' and c->>'score' ~ '^\d+$' limit 1),
             (select nullif(c->>'score', '')::int from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'away' and c->>'score' ~ '^\d+$' limit 1),
             (ev->'status'->'type'->>'completed')::boolean,
             now()
        from jsonb_array_elements(v_body->'events') ev
       where ev->>'id' is not null
      on conflict (league, event_id) do update
         set match_date = excluded.match_date, kickoff = excluded.kickoff, home_name = excluded.home_name,
             away_name = excluded.away_name, home_score = excluded.home_score, away_score = excluded.away_score,
             completed = excluded.completed, refreshed_at = now();
      get diagnostics v_kept = row_count;
      v_rows := v_rows + v_kept;

      update public.espn_soccer_scoreboard_fetches
         set status = 'ok', fetched_at = now(), events = v_kept, last_error = null
       where league = q.league and match_date = q.match_date;
    -- when-others-timeout-blind: intentional — record this date's failure and continue to the next;
    -- the loop is bounded (60 dates) and a statement_timeout kill of the whole drain leaves every
    -- undrained date 'requested' for the next tick (re-requested after an hour), which is correct.
    exception when others then
      get stacked diagnostics v_err_text = message_text;
      v_errs := v_errs + 1;
      update public.espn_soccer_scoreboard_fetches
         set status = 'error', fetched_at = now(), last_error = left(v_err_text, 300)
       where league = q.league and match_date = q.match_date;
      v_error := coalesce(v_error || ' | ', '') || left(v_err_text, 200);
    end;
  end loop;

  if v_reqs = 0 then
    return jsonb_build_object('drained', 0);
  end if;

  v_ok := v_errs = 0 or v_errs < v_reqs / 4.0;

  perform public.log_pipeline_run(
    'golazos-match-results', v_started, v_reqs, v_rows, 0, v_ok, v_error,
    null, null, null,
    jsonb_build_object('dates', v_reqs, 'date_errors', v_errs, 'matches_written', v_rows,
                       'dates_ok', (select count(*) from public.espn_soccer_scoreboard_fetches where status = 'ok'),
                       'date_errors_total', (select count(*) from public.espn_soccer_scoreboard_fetches where status = 'error'),
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('ok', v_ok, 'dates', v_reqs, 'errors', v_errs, 'matches', v_rows, 'error', v_error);
end
$$;
-- anon-exec: revoked (espn_soccer_scoreboard_drain) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_soccer_scoreboard_drain() from public, anon, authenticated;
grant execute on function public.espn_soccer_scoreboard_drain() to postgres, service_role;

insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
values ('golazos-match-results', 20160, 20160, 'info',
  'Added 2026-11-26 with the Golazos match-result lane (espn_soccer_scoreboard_dispatch at :07/:27/:47, drain at :09/:29/:49; pg_net to ESPN''s LaLiga scoreboard per Golazos match date). Logs only when it drained dates: a few hours of backfill (316 dates), then only new Golazos dates. ok=false when >=25% of a tick''s dates fail. info until a human read promotes it.',
  true);

select cron.schedule('rpc-golazos-scoreboard-dispatch', '7,27,47 * * * *', 'select public.espn_soccer_scoreboard_dispatch()');
select cron.schedule('rpc-golazos-scoreboard-drain',    '9,29,49 * * * *', 'select public.espn_soccer_scoreboard_drain()');
