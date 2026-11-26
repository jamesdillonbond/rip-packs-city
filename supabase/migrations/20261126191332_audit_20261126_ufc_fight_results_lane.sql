-- audit_20261126_ufc_fight_results_lane
--
-- The slab's back for UFC Strike: the FIGHT a Moment is from (Trevor 2026-11-26, "Keep going" on the
-- slab for every collection). 539 of 625 UFC Strike editions name their event in the set name —
-- "UFC 303 KO TKO" (283, numbered) or "UFC FIGHT NIGHT FEB 6 2021 KO TKO" (256, dated); the rest are
-- catchphrase Moments ("KHABIB TIME") with no fight.
--
-- ESPN (probed 11-26 from pg_net): site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=YYYY
-- answers EVERY UFC event of that year with every bout (2024: 56 events, 1.4 MB; 1996: 5 events —
-- coverage reaches UFC 8). A bout carries both fighters (ESPN athlete id, name, winner), the weight
-- class, the round it ended in and the clock. It carries NO method — the Moment's own set name does.
--
--   espn_mma_year_fetches   one row per year: requested → ok | error (≤ 3 attempts); the CURRENT year
--                           is re-requested once a day (new events)
--   espn_mma_fight_sides    one row per fighter per bout
--   ufc_name_key(text)      a fighter name as a comparable key (accents folded, punctuation dropped)
--   espn_mma_scoreboard_dispatch()  pg_cron :13 hourly — the years 1993..now not yet fetched
--   espn_mma_scoreboard_drain()     pg_cron :16 hourly — parse, upsert, log_pipeline_run('ufc-fight-results')
--   get_ufc_moment_fight(uuid)      the reader: the edition's event (exactly one) and its fighter's
--                                   bout in it (exactly one), or NULL
--
-- Revert:
--   select cron.unschedule('rpc-ufc-scoreboard-dispatch'); select cron.unschedule('rpc-ufc-scoreboard-drain');
--   delete from public.pipeline_cadence_watchlist where pipeline = 'ufc-fight-results';
--   drop function public.get_ufc_moment_fight(uuid); drop function public.espn_mma_scoreboard_drain();
--   drop function public.espn_mma_scoreboard_dispatch(); drop function public.ufc_name_key(text);
--   drop table public.espn_mma_fight_sides; drop table public.espn_mma_year_fetches;

create table public.espn_mma_year_fetches (
  year         int primary key,
  status       text not null check (status in ('requested', 'ok', 'error')),
  request_id   bigint,
  requested_at timestamptz,
  fetched_at   timestamptz,
  attempts     int not null default 0,
  events       int,
  last_error   text
);

create table public.espn_mma_fight_sides (
  competition_id text not null,
  athlete_id     text not null,
  event_id       text not null,
  event_name     text not null,
  event_at       timestamptz,
  weight_class   text,
  rounds         int,
  end_period     int,
  end_clock      text,
  completed      boolean,
  athlete_name   text not null,
  winner         boolean,
  opponent_id    text,
  opponent_name  text,
  refreshed_at   timestamptz not null default now(),
  primary key (competition_id, athlete_id)
);
create index espn_mma_fight_sides_event_idx on public.espn_mma_fight_sides (event_id);

alter table public.espn_mma_year_fetches enable row level security;
alter table public.espn_mma_fight_sides enable row level security;
revoke all on public.espn_mma_year_fetches, public.espn_mma_fight_sides from public, anon, authenticated;
grant all on public.espn_mma_year_fetches, public.espn_mma_fight_sides to service_role;

-- "José Aldo" and "Jose Aldo", "T.J. Dillashaw" and "TJ Dillashaw" → one key.
CREATE OR REPLACE FUNCTION public.ufc_name_key(p_name text)
returns text
language sql stable
set search_path = pg_catalog, public
as $$
  select nullif(btrim(regexp_replace(regexp_replace(lower(extensions.unaccent(coalesce(p_name, ''))), '[.''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g')), '')
$$;
-- anon-exec: revoked (ufc_name_key) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.ufc_name_key(text) from public, anon, authenticated;
grant execute on function public.ufc_name_key(text) to postgres, service_role;

CREATE OR REPLACE FUNCTION public.espn_mma_scoreboard_dispatch()
returns int
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  r     record;
  v_req bigint;
  v_n   int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_mma_scoreboard_dispatch')::bigint) then
    return 0;
  end if;
  for r in
    select y.year
      from generate_series(1993, extract(year from now())::int) y(year)
      left join public.espn_mma_year_fetches f on f.year = y.year
     where f.year is null
        or (f.status = 'error' and f.attempts < 3 and coalesce(f.fetched_at, f.requested_at) < now() - interval '1 hour')
        or (f.status = 'requested' and f.requested_at < now() - interval '1 hour')
        -- the current year keeps adding events: once a day
        or (y.year = extract(year from now())::int and f.status = 'ok' and f.fetched_at < now() - interval '1 day')
     order by y.year desc
     limit 12
  loop
    v_req := net.http_get('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=' || r.year, timeout_milliseconds => 30000);
    insert into public.espn_mma_year_fetches as f (year, status, request_id, requested_at, attempts)
    values (r.year, 'requested', v_req, now(), 1)
    on conflict (year) do update
       set status = 'requested', request_id = excluded.request_id, requested_at = now(),
           attempts = case when f.status = 'ok' then 1 else f.attempts + 1 end;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
-- anon-exec: revoked (espn_mma_scoreboard_dispatch) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_mma_scoreboard_dispatch() from public, anon, authenticated;
grant execute on function public.espn_mma_scoreboard_dispatch() to postgres, service_role;

CREATE OR REPLACE FUNCTION public.espn_mma_scoreboard_drain()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_started  timestamptz := clock_timestamp();
  q          record;
  v_body     jsonb;
  v_kept     int;
  v_events   int;
  v_reqs     int := 0;
  v_errs     int := 0;
  v_rows     int := 0;
  v_err_text text;
  v_error    text;
  v_ok       boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_mma_scoreboard_drain')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  for q in
    select f.year, r0.status_code, r0.content, r0.error_msg, r0.timed_out
      from public.espn_mma_year_fetches f
      left join net._http_response r0 on r0.id = f.request_id
     where f.status = 'requested'
       and (r0.id is not null or f.requested_at < now() - interval '10 minutes')
     order by f.requested_at
     limit 12
  loop
    v_reqs := v_reqs + 1;
    begin
      if q.status_code is null or q.status_code <> 200 or q.timed_out then
        raise exception 'espn ufc scoreboard % (%): %', q.year, coalesce(q.status_code::text, 'no-response'),
          left(coalesce(q.error_msg, q.content, ''), 120);
      end if;
      v_body := q.content::jsonb;
      if jsonb_typeof(v_body->'events') <> 'array' then
        raise exception 'espn ufc scoreboard %: no events array', q.year;
      end if;
      v_events := jsonb_array_length(v_body->'events');

      insert into public.espn_mma_fight_sides as s
        (competition_id, athlete_id, event_id, event_name, event_at, weight_class, rounds, end_period, end_clock,
         completed, athlete_name, winner, opponent_id, opponent_name, refreshed_at)
      select c->>'id', x->>'id', ev->>'id', ev->>'name', (ev->>'date')::timestamptz,
             c->'type'->>'abbreviation',
             nullif(c->'format'->'regulation'->>'periods', '')::int,
             nullif(c->'status'->>'period', '')::int,
             nullif(c->'status'->>'displayClock', ''),
             (c->'status'->'type'->>'completed')::boolean,
             coalesce(x->'athlete'->>'displayName', x->'athlete'->>'fullName'),
             case x->>'winner' when 'true' then true when 'false' then false end,
             oo.o->>'id', coalesce(oo.o->'athlete'->>'displayName', oo.o->'athlete'->>'fullName'),
             now()
        from jsonb_array_elements(v_body->'events') ev
        cross join lateral jsonb_array_elements(coalesce(ev->'competitions', '[]'::jsonb)) c
        cross join lateral jsonb_array_elements(coalesce(c->'competitors', '[]'::jsonb)) x
        left join lateral (
          select y from jsonb_array_elements(coalesce(c->'competitors', '[]'::jsonb)) y
           where y->>'id' is distinct from x->>'id' limit 1) oo(o) on true
       where c->>'id' is not null and x->>'id' is not null and ev->>'id' is not null
         and coalesce(x->'athlete'->>'displayName', x->'athlete'->>'fullName') is not null
      on conflict (competition_id, athlete_id) do update
         set event_id = excluded.event_id, event_name = excluded.event_name, event_at = excluded.event_at,
             weight_class = excluded.weight_class, rounds = excluded.rounds, end_period = excluded.end_period,
             end_clock = excluded.end_clock, completed = excluded.completed, athlete_name = excluded.athlete_name,
             winner = excluded.winner, opponent_id = excluded.opponent_id, opponent_name = excluded.opponent_name,
             refreshed_at = now();
      get diagnostics v_kept = row_count;
      v_rows := v_rows + v_kept;

      update public.espn_mma_year_fetches
         set status = 'ok', fetched_at = now(), events = v_events, last_error = null
       where year = q.year;
    -- when-others-timeout-blind: intentional — record this year's failure and continue to the next;
    -- the loop is bounded (12 years) and a statement_timeout kill of the whole drain leaves every
    -- undrained year 'requested' for the next tick (re-requested after an hour), which is correct.
    exception when others then
      get stacked diagnostics v_err_text = message_text;
      v_errs := v_errs + 1;
      update public.espn_mma_year_fetches
         set status = 'error', fetched_at = now(), last_error = left(v_err_text, 300)
       where year = q.year;
      v_error := coalesce(v_error || ' | ', '') || left(v_err_text, 200);
    end;
  end loop;

  if v_reqs = 0 then
    return jsonb_build_object('drained', 0);
  end if;

  v_ok := v_errs = 0 or v_errs < v_reqs / 4.0;

  perform public.log_pipeline_run(
    'ufc-fight-results', v_started, v_reqs, v_rows, 0, v_ok, v_error,
    null, null, null,
    jsonb_build_object('years', v_reqs, 'year_errors', v_errs, 'sides_written', v_rows,
                       'years_ok', (select count(*) from public.espn_mma_year_fetches where status = 'ok'),
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('ok', v_ok, 'years', v_reqs, 'errors', v_errs, 'sides', v_rows, 'error', v_error);
end
$$;
-- anon-exec: revoked (espn_mma_scoreboard_drain) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_mma_scoreboard_drain() from public, anon, authenticated;
grant execute on function public.espn_mma_scoreboard_drain() to postgres, service_role;

-- The reader. The event: "UFC <n> …" → the ONE ESPN event named "UFC <n>" followed by a non-digit
-- ("UFC 30" is not "UFC 300"); "UFC FIGHT NIGHT MON D YYYY …" → the ONE event (not a Contender Series
-- card) starting that UTC date or the next (a US evening card starts after midnight UTC). Then the
-- ONE bout in it whose fighter's name key is the Moment's. Anything else — a catchphrase Moment, two
-- candidate events, a fighter not found or found twice — is NULL: no claim.
CREATE OR REPLACE FUNCTION public.get_ufc_moment_fight(p_edition_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_set    text;
  v_name   text;
  v_num    text;
  v_date   date;
  v_parts  text[];
  v_events text[];
  v_n      int;
  v_side   public.espn_mma_fight_sides%rowtype;
begin
  select e.set_name, public.ufc_name_key(e.player_name)
    into v_set, v_name
    from public.editions e
    join public.collections c on c.id = e.collection_id and c.slug = 'ufc_strike'
   where e.id = p_edition_id;
  if v_set is null or v_name is null then
    return null;
  end if;

  v_num := substring(v_set from '^UFC (\d+)(?:\s|$)');
  if v_num is not null then
    select array_agg(distinct s.event_id) into v_events
      from public.espn_mma_fight_sides s
     where s.event_name ~* ('^UFC ' || v_num || '([^0-9]|$)');
  else
    v_parts := regexp_match(v_set, '^UFC FIGHT NIGHT (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) (\d{1,2}) (\d{4})');
    if v_parts is null or v_parts[2]::int not between 1 and 31 then
      return null;
    end if;
    v_date := make_date(v_parts[3]::int,
                        array_position(array['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'], v_parts[1]),
                        v_parts[2]::int);
    select array_agg(distinct s.event_id) into v_events
      from public.espn_mma_fight_sides s
     where (s.event_at at time zone 'UTC')::date in (v_date, v_date + 1)
       and s.event_name !~* 'contender';
  end if;
  if coalesce(array_length(v_events, 1), 0) <> 1 then
    return null;
  end if;

  select count(*) into v_n
    from public.espn_mma_fight_sides s
   where s.event_id = v_events[1] and public.ufc_name_key(s.athlete_name) = v_name;
  if v_n <> 1 then
    return null;
  end if;
  select s.* into v_side
    from public.espn_mma_fight_sides s
   where s.event_id = v_events[1] and public.ufc_name_key(s.athlete_name) = v_name;

  return jsonb_build_object(
    'event_id', v_side.event_id,
    'event_name', v_side.event_name,
    -- the card's date as ESPN shows it (US Eastern: a 00:00Z start is the night before)
    'event_date', to_char(v_side.event_at at time zone 'America/New_York', 'YYYY-MM-DD'),
    'weight_class', v_side.weight_class,
    'rounds', v_side.rounds,
    'end_period', v_side.end_period,
    'end_clock', v_side.end_clock,
    'completed', v_side.completed,
    'winner', v_side.winner,
    'opponent_name', v_side.opponent_name,
    'set_name', v_set
  );
end
$$;
-- anon-exec: revoked (get_ufc_moment_fight) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.get_ufc_moment_fight(uuid) from public, anon, authenticated;
grant execute on function public.get_ufc_moment_fight(uuid) to postgres, service_role;

insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
values ('ufc-fight-results', 4320, 4320, 'info',
  'Added 2026-11-26 with the UFC Strike fight lane (espn_mma_scoreboard_dispatch :13, drain :16 hourly; pg_net to ESPN''s UFC scoreboard per YEAR, 1993..now). Backfill of ~34 years in the first ticks, then the current year once a day. ok=false when >=25% of a tick''s years fail. info until a human read promotes it.',
  true);

select cron.schedule('rpc-ufc-scoreboard-dispatch', '13 * * * *', 'select public.espn_mma_scoreboard_dispatch()');
select cron.schedule('rpc-ufc-scoreboard-drain',    '16 * * * *', 'select public.espn_mma_scoreboard_drain()');
