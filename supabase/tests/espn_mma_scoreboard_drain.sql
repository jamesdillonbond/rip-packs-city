-- DB invariant: the UFC Strike fight lane (2026-11-26) — the slab back's "This fight".
--
-- Rules pinned here:
--   (a) the drain stores one row per fighter per bout, each with its opponent, from ESPN's yearly
--       UFC scoreboard; a failed year is 'error', never a partial write;
--   (b) the dispatch asks every year 1993..now once, and the CURRENT year again after a day;
--   (c) the reader finds the edition's event — "UFC <n>" by number (UFC 30 is not UFC 300), "UFC FIGHT
--       NIGHT MON D YYYY" by date (that UTC date or the next, never a Contender Series card) — exactly
--       one event, then exactly one bout of the Moment's fighter in it (accents and punctuation folded);
--       a catchphrase Moment, a second candidate event, or a fighter not on the card is NULL;
--   (d) a full month name ("JUNE 23 2018") is that month; a fighter ESPN names differently is found by
--       his surname when exactly one fighter on that card carries it (a Jr./II suffix is not the
--       surname); a Fight Night named by its main event finds that event (20261126191951).
--
-- The function DDL below is VERBATIM from
-- supabase/migrations/20261126191332_audit_20261126_ufc_fight_results_lane.sql (lane, ufc_name_key) and
-- supabase/migrations/20261126191951_audit_20261126_ufc_moment_fight_names_and_months.sql (get_ufc_moment_fight);
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text, timed_out boolean);
CREATE TABLE net._test_requests (id bigserial PRIMARY KEY, url text);
CREATE FUNCTION net.http_get(url text, timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net._test_requests (url) VALUES (url) RETURNING id
$$;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, player_name text, set_name text);
CREATE TABLE public.pipeline_runs_test (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started timestamptz, p_in int, p_written int, p_skipped int,
  p_ok boolean, p_error text, a text, b text, c text, p_extra jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.pipeline_runs_test VALUES (p_pipeline, p_ok, p_extra)
$$;

CREATE TABLE public.espn_mma_year_fetches (
  year int primary key, status text not null check (status in ('requested', 'ok', 'error')),
  request_id bigint, requested_at timestamptz, fetched_at timestamptz, attempts int not null default 0,
  events int, last_error text
);
CREATE TABLE public.espn_mma_fight_sides (
  competition_id text not null, athlete_id text not null, event_id text not null, event_name text not null,
  event_at timestamptz, weight_class text, rounds int, end_period int, end_clock text, completed boolean,
  athlete_name text not null, winner boolean, opponent_id text, opponent_name text,
  refreshed_at timestamptz not null default now(), primary key (competition_id, athlete_id)
);

CREATE OR REPLACE FUNCTION public.ufc_name_key(p_name text)
returns text
language sql stable
set search_path = pg_catalog, public
as $$
  select nullif(btrim(regexp_replace(regexp_replace(lower(extensions.unaccent(coalesce(p_name, ''))), '[.''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g')), '')
$$;

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

CREATE OR REPLACE FUNCTION public.get_ufc_moment_fight(p_edition_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_set    text;
  v_name   text;
  v_last   text;
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
  elsif v_set ~ '^UFC FIGHT NIGHT [A-Z][A-Z'' -]* VS [A-Z]' then
    -- a Fight Night named by its main event ("UFC FIGHT NIGHT GARCIA VS ONAMA KO TKO"): ESPN's
    -- "UFC Fight Night: Garcia vs. Onama" — both names, in order, right after the colon
    v_parts := regexp_match(v_set, '^UFC FIGHT NIGHT ([A-Z][A-Z'' -]*?) VS ([A-Z][A-Z''-]*)');
    select array_agg(distinct s.event_id) into v_events
      from public.espn_mma_fight_sides s
     where public.ufc_name_key(s.event_name) like 'ufc fight night ' || public.ufc_name_key(v_parts[1]) || ' vs ' || public.ufc_name_key(v_parts[2]) || '%';
  else
    -- Strike writes both "JUN 23 2018" and "JUNE 23 2018" (and "SEPT"): the first three letters are the month
    v_parts := regexp_match(v_set, '^UFC FIGHT NIGHT (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]* (\d{1,2}) (\d{4})');
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
  if v_n = 1 then
    select s.* into v_side
      from public.espn_mma_fight_sides s
     where s.event_id = v_events[1] and public.ufc_name_key(s.athlete_name) = v_name;
  elsif v_n = 0 then
    -- Strike and ESPN name some fighters differently ("Shogun Rua" / "Mauricio Rua", "Ian Garry" /
    -- "Ian Machado Garry", "Raul Rosas" / "Raul Rosas Jr."). On ONE card, a surname is a person when
    -- exactly one fighter carries it (a suffix like Jr. or II is not the surname).
    v_last := (regexp_match(regexp_replace(v_name, '( (jr|sr|ii|iii|iv))+$', ''), '([a-z0-9]+)$'))[1];
    if v_last is null or length(v_last) < 3 then
      return null;
    end if;
    select count(*) into v_n
      from public.espn_mma_fight_sides s
     where s.event_id = v_events[1]
       and (regexp_match(regexp_replace(public.ufc_name_key(s.athlete_name), '( (jr|sr|ii|iii|iv))+$', ''), '([a-z0-9]+)$'))[1] = v_last;
    if v_n <> 1 then
      return null;
    end if;
    select s.* into v_side
      from public.espn_mma_fight_sides s
     where s.event_id = v_events[1]
       and (regexp_match(regexp_replace(public.ufc_name_key(s.athlete_name), '( (jr|sr|ii|iii|iv))+$', ''), '([a-z0-9]+)$'))[1] = v_last;
  else
    return null;
  end if;

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

-- ── fixtures ────────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.collections VALUES ('00000000-0000-0000-0000-0000000000c1', 'ufc_strike'), ('00000000-0000-0000-0000-0000000000c2', 'nba_top_shot');
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'Vinicius Oliveira', 'UFC 303 KO TKO'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 'José Aldo', 'UFC FIGHT NIGHT FEB 6 2021 KO TKO'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000c1', 'Khabib Nurmagomedov', 'KHABIB TIME'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000c1', 'Ricky Simon', 'UFC 30 KO TKO'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000c1', 'Somebody Else', 'UFC 303 KO TKO'),
  ('00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-0000000000c2', 'Vinicius Oliveira', 'UFC 303 KO TKO');

-- (b) dispatch: every year once
SELECT _assert(espn_mma_scoreboard_dispatch() = 12, 'b: twelve years per run');
SELECT _assert((SELECT count(*) FROM net._test_requests WHERE url LIKE '%scoreboard?dates=' || extract(year from now())::int) = 1, 'b: newest year first');
UPDATE espn_mma_year_fetches SET status = 'ok', fetched_at = now();
SELECT _assert(espn_mma_scoreboard_dispatch() = 12, 'b: the next twelve');
UPDATE espn_mma_year_fetches SET status = 'ok', fetched_at = now();
SELECT espn_mma_scoreboard_dispatch();
UPDATE espn_mma_year_fetches SET status = 'ok', fetched_at = now();
SELECT _assert(espn_mma_scoreboard_dispatch() = 0, 'b: nothing left once every year is ok');
UPDATE espn_mma_year_fetches SET fetched_at = now() - interval '2 days' WHERE year = extract(year from now())::int;
SELECT _assert(espn_mma_scoreboard_dispatch() = 1, 'b: the current year again after a day');

-- (a) drain: a year's events → one row per fighter per bout, each with its opponent
UPDATE espn_mma_year_fetches SET status = 'requested', request_id = 7001 WHERE year = 2024;
UPDATE espn_mma_year_fetches SET status = 'requested', request_id = 7002 WHERE year = 2021;
UPDATE espn_mma_year_fetches SET status = 'requested', request_id = 7003 WHERE year = 2001;
INSERT INTO net._http_response VALUES (7001, 200, jsonb_build_object('events', jsonb_build_array(
  jsonb_build_object('id', '600041', 'name', 'UFC 303: Pereira vs. Procházka 2', 'date', '2024-06-29T22:00Z', 'competitions', jsonb_build_array(
    jsonb_build_object('id', '401', 'type', jsonb_build_object('abbreviation', 'Bantamweight'), 'format', jsonb_build_object('regulation', jsonb_build_object('periods', 3)),
      'status', jsonb_build_object('period', 1, 'displayClock', '3:41', 'type', jsonb_build_object('completed', true)),
      'competitors', jsonb_build_array(
        jsonb_build_object('id', '3922491', 'winner', 'false', 'athlete', jsonb_build_object('displayName', 'Ricky Simon')),
        jsonb_build_object('id', '4884877', 'winner', 'true', 'athlete', jsonb_build_object('displayName', 'Vinicius Oliveira')))))),
  jsonb_build_object('id', '600099', 'name', 'Dana White''s Contender Series: Season 8, Week 1', 'date', '2024-08-13T23:00Z', 'competitions', '[]'::jsonb)))::text, NULL, false);
INSERT INTO net._http_response VALUES (7002, 200, jsonb_build_object('events', jsonb_build_array(
  jsonb_build_object('id', '500006', 'name', 'UFC Fight Night: Overeem vs. Volkov', 'date', '2021-02-06T21:00Z', 'competitions', jsonb_build_array(
    jsonb_build_object('id', '301', 'type', jsonb_build_object('abbreviation', 'Bantamweight'), 'format', jsonb_build_object('regulation', jsonb_build_object('periods', 3)),
      'status', jsonb_build_object('period', 3, 'displayClock', '5:00', 'type', jsonb_build_object('completed', true)),
      'competitors', jsonb_build_array(
        jsonb_build_object('id', '11', 'winner', 'true', 'athlete', jsonb_build_object('displayName', 'Jose Aldo')),
        jsonb_build_object('id', '12', 'winner', 'false', 'athlete', jsonb_build_object('displayName', 'Marlon Vera'))))))))::text, NULL, false);
INSERT INTO net._http_response VALUES (7003, 500, 'boom', NULL, false);
SELECT espn_mma_scoreboard_drain();
SELECT _assert((SELECT count(*) FROM espn_mma_fight_sides) = 4, 'a: one row per fighter per bout');
SELECT _assert_eq((SELECT opponent_name FROM espn_mma_fight_sides WHERE athlete_name = 'Vinicius Oliveira'), 'Ricky Simon', 'a: each side carries its opponent');
SELECT _assert_eq((SELECT status FROM espn_mma_year_fetches WHERE year = 2001), 'error', 'a: a failed year is error');
SELECT _assert_eq((SELECT events::text FROM espn_mma_year_fetches WHERE year = 2024), '2', 'a: the year records its events');

-- (c) the reader
SELECT _assert_eq((SELECT get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e1')->>'opponent_name'), 'Ricky Simon', 'c: numbered event, the fighter''s bout');
SELECT _assert_eq((SELECT get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e1')->>'winner'), 'true', 'c: his result');
SELECT _assert_eq((SELECT get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e1')->>'end_clock'), '3:41', 'c: when it ended');
SELECT _assert_eq((SELECT get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e2')->>'opponent_name'), 'Marlon Vera', 'c: a dated Fight Night, accents folded');
SELECT _assert(get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e3') IS NULL, 'c: a catchphrase Moment has no fight');
SELECT _assert(get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e4') IS NULL, 'c: UFC 30 is not UFC 303');
SELECT _assert(get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e5') IS NULL, 'c: a fighter not on the card is NULL');
SELECT _assert(get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e6') IS NULL, 'c: not a UFC Strike edition');
-- a second event on the same date makes the dated read ambiguous
INSERT INTO espn_mma_fight_sides (competition_id, athlete_id, event_id, event_name, event_at, athlete_name)
VALUES ('999', '1', '500007', 'UFC on ESPN: Other card', '2021-02-07T01:00Z', 'Jose Aldo');
SELECT _assert(get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e2') IS NULL, 'c: two candidate events is NULL');
SELECT _assert_eq(ufc_name_key('T.J. Dillashaw'), 'tj dillashaw', 'c: punctuation folded');

-- (d) months in full, names ESPN spells differently, named Fight Nights
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000e7', '00000000-0000-0000-0000-0000000000c1', 'Shogun Rua', 'UFC FIGHT NIGHT JUNE 23 2018 KO TKO'),
  ('00000000-0000-0000-0000-0000000000e8', '00000000-0000-0000-0000-0000000000c1', 'Dan Silva', 'UFC FIGHT NIGHT JUNE 23 2018 KO TKO'),
  ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000c1', 'Steve Garcia', 'UFC FIGHT NIGHT GARCIA VS ONAMA KO TKO');
INSERT INTO espn_mma_fight_sides (competition_id, athlete_id, event_id, event_name, event_at, completed, athlete_name, winner, opponent_name) VALUES
  ('801', '21', '700001', 'UFC Fight Night: Cerrone vs. Edwards', '2018-06-23T09:00Z', true, 'Mauricio Rua', true, 'Tyson Pedro'),
  ('801', '22', '700001', 'UFC Fight Night: Cerrone vs. Edwards', '2018-06-23T09:00Z', true, 'Tyson Pedro', false, 'Mauricio Rua'),
  ('802', '23', '700001', 'UFC Fight Night: Cerrone vs. Edwards', '2018-06-23T09:00Z', true, 'Joao Silva', true, 'X'),
  ('803', '24', '700001', 'UFC Fight Night: Cerrone vs. Edwards', '2018-06-23T09:00Z', true, 'Ana Silva Jr.', true, 'Y'),
  ('804', '25', '700002', 'UFC Fight Night: Garcia vs. Onama', '2025-11-01T21:00Z', true, 'Steven Garcia', true, 'David Onama');
SELECT _assert_eq((SELECT get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e7')->>'opponent_name'), 'Tyson Pedro', 'd: JUNE is June; Shogun Rua found as the card''s only Rua');
SELECT _assert(get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e8') IS NULL, 'd: a surname two fighters on the card carry (Silva, Silva Jr.) is no one');
SELECT _assert_eq((SELECT get_ufc_moment_fight('00000000-0000-0000-0000-0000000000e9')->>'opponent_name'), 'David Onama', 'd: a Fight Night named by its main event');

ROLLBACK;
