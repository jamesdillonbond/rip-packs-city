-- audit_20261108_espn_bio_404_league_fallback
--
-- 13 Top Shot players' ESPN athlete records 404 at /leagues/nba/athletes/<id> (Kenneth Faried,
-- Nate Robinson, Mario Chalmers, Doc Rivers …). The ids are RIGHT — ESPN's search lists each as
-- default league `nba-development`, and /leagues/nba-development/athletes/<id> answers 200 with the
-- full record (measured 2026-11-08: Faried b. 1989-11-19, Newark NJ, college 2413; Candace Parker
-- b. 1986-04-19, Naperville IL). espn_athlete_bio_tick now retries a league-path 404 immediately on
-- the sport's development / college league (basketball → nba-development, football →
-- college-football, baseball → college-baseball), within the existing 3-attempt cap.
--
-- Also recorded here (built CONCURRENTLY via execute_sql on 2026-11-08, both indisvalid = true —
-- CIC cannot run inside a migration transaction, so this file documents them):
--   idx_player_identities_espn_id ON player_identities (espn_id) WHERE espn_id IS NOT NULL
--   idx_espn_athletes_espn_id     ON espn_athletes (espn_id)
--   espn_bio_targets() — run by every bio tick — fell from 4.9 s / 1.58M buffers to 0.28 s / 16k.
--   create index if not exists below is a no-op on prod and builds them on a fresh database.
--
-- Revert: re-apply the 20261108214928 body of espn_athlete_bio_tick. (Indexes:
--   drop index concurrently public.idx_player_identities_espn_id; drop index concurrently public.idx_espn_athletes_espn_id;)

create index if not exists idx_player_identities_espn_id on public.player_identities (espn_id) where espn_id is not null;
create index if not exists idx_espn_athletes_espn_id on public.espn_athletes (espn_id);

create or replace function public.espn_athlete_bio_tick()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started    timestamptz := clock_timestamp();
  v_drained    int := 0;
  v_ok         int := 0;
  v_dob        int := 0;
  v_errs       int := 0;
  v_requested  int := 0;
  v_c_drained  int := 0;
  v_c_errs     int := 0;
  v_c_req      int := 0;
  v_ok_run     boolean;
  v_xwalk      jsonb;
  v_sxw        jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_athlete_bio_tick')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  -- 1. Drain athletes: a response that arrived, or an in-flight request older than 10 minutes.
  with r as (
    select b.sport, b.espn_id, h.status_code, h.error_msg,
           case when h.status_code = 200 and not coalesce(h.timed_out, false)
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as body
      from public.espn_athlete_bio b
      left join net._http_response h on h.id = b.request_id
     where b.request_id is not null
       and (h.id is not null or b.requested_at < now() - interval '10 minutes')
  ), p as (
    select r.*,
           case when r.body->>'dateOfBirth' ~ '^\d{4}-\d{2}-\d{2}' then left(r.body->>'dateOfBirth', 10)::date end as dob
      from r
  ), u as (
    update public.espn_athlete_bio b
       set status         = case when p.body is null then (case when b.status = 'ok' then 'ok' else 'error' end)
                                 when p.dob is null then 'no_dob' else 'ok' end,
           date_of_birth  = case when p.body is null then b.date_of_birth else p.dob end,
           display_name   = coalesce(p.body->>'displayName', b.display_name),
           birth_city     = case when p.body is null then b.birth_city else nullif(p.body->'birthPlace'->>'city', '') end,
           birth_state    = case when p.body is null then b.birth_state else nullif(p.body->'birthPlace'->>'state', '') end,
           birth_country  = case when p.body is null then b.birth_country else nullif(p.body->'birthPlace'->>'country', '') end,
           citizenship    = case when p.body is null then b.citizenship else nullif(p.body->>'citizenship', '') end,
           college_id     = case when p.body is null then b.college_id
                                 else substring(p.body->'college'->>'$ref' from '/colleges/(\d+)') end,
           fields_version = case when p.body is null then b.fields_version else 3 end,
           fetched_at     = now(),
           request_id     = null,
           last_error     = case when p.body is null
                                 then left('espn core ' || coalesce(p.status_code::text, 'no-response') || ' ' || coalesce(p.error_msg, ''), 200) end
      from p
     where b.sport = p.sport and b.espn_id = p.espn_id
    returning p.body is not null as answered, p.dob is not null as has_dob
  )
  select count(*), count(*) filter (where answered), count(*) filter (where has_dob), count(*) filter (where not answered)
    into v_drained, v_ok, v_dob, v_errs from u;

  -- 2. Drain colleges.
  with r as (
    select c.college_id, h.status_code, h.error_msg,
           case when h.status_code = 200 and not coalesce(h.timed_out, false)
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as body
      from public.espn_colleges c
      left join net._http_response h on h.id = c.request_id
     where c.request_id is not null
       and (h.id is not null or c.requested_at < now() - interval '10 minutes')
  ), u as (
    update public.espn_colleges c
       set status     = case when r.body is null or r.body->>'name' is null then 'error' else 'ok' end,
           name       = coalesce(r.body->>'name', c.name),
           short_name = coalesce(r.body->>'shortName', c.short_name),
           abbrev     = coalesce(r.body->>'abbrev', c.abbrev),
           fetched_at = now(),
           request_id = null,
           last_error = case when r.body is null or r.body->>'name' is null
                             then left('espn college ' || coalesce(r.status_code::text, 'no-response') || ' ' || coalesce(r.error_msg, ''), 200) end
      from r
     where c.college_id = r.college_id
    returning c.status
  )
  select count(*), count(*) filter (where status = 'error') into v_c_drained, v_c_errs from u;

  -- A stored DOB can settle a pending Golazos link: refresh before dispatching more.
  if v_dob > 0 then
    v_xwalk := public.refresh_golazos_espn_crosswalk();
    v_sxw   := public.refresh_espn_search_crosswalk();  -- same-DOB duplicate ESPN records settle here
  end if;

  -- 3. Dispatch athletes: never fetched, fetched before birthplace/college were captured, or an
  --    error due a retry (after a day, 3 tries). Never two requests in flight for one athlete.
  --    fields_version 3 = DOB + birthplace + college + citizenship.
  --    A 404 at the league path retries at once on the sport's development / college league:
  --    ESPN files retired players there (Kenneth Faried, Nate Robinson, Candace Parker → nba-development).
  with need as (
    select t.sport,
           case when b.status = 'error' and b.last_error like 'espn core 404%'
                then case t.sport when 'basketball' then 'nba-development' when 'football' then 'college-football'
                                  when 'baseball' then 'college-baseball' else t.league_seg end
                else t.league_seg end as league_seg,
           t.espn_id
      from public.espn_bio_targets() t
      left join public.espn_athlete_bio b on b.sport = t.sport and b.espn_id = t.espn_id
     where b.espn_id is null
        or (b.request_id is null and b.fields_version < 3 and b.status <> 'error' and b.attempts < 8)
        or (b.request_id is null and b.status = 'error' and b.attempts < 3
            and (b.fetched_at < now() - interval '1 day' or b.last_error like 'espn core 404%'))
     order by (b.espn_id is not null), t.sport, t.espn_id
     limit 200
  ), req as (
    select n.sport, n.league_seg, n.espn_id,
           net.http_get(
             case when n.sport = 'soccer' or n.league_seg is null
                  then format('https://sports.core.api.espn.com/v2/sports/%s/athletes/%s', n.sport, n.espn_id)
                  else format('https://sports.core.api.espn.com/v2/sports/%s/leagues/%s/athletes/%s', n.sport, n.league_seg, n.espn_id) end,
             timeout_milliseconds := 15000) as request_id
      from need n
  ), ins as (
    insert into public.espn_athlete_bio as b (sport, espn_id, league_seg, status, request_id, requested_at, attempts)
    select sport, espn_id, league_seg, 'new', request_id, now(), 1 from req
    on conflict (sport, espn_id) do update set
      league_seg = excluded.league_seg, request_id = excluded.request_id, requested_at = now(), attempts = b.attempts + 1
    returning 1
  )
  select count(*) into v_requested from ins;

  -- 4. Dispatch colleges named by any athlete and not yet cached (errors retry after a day, 3 tries).
  with need as (
    select distinct b.college_id
      from public.espn_athlete_bio b
      left join public.espn_colleges c on c.college_id = b.college_id
     where b.college_id is not null
       and (c.college_id is null
            or (c.request_id is null and c.status = 'error' and c.attempts < 3 and c.fetched_at < now() - interval '1 day'))
     order by b.college_id
     limit 100
  ), req as (
    select n.college_id,
           net.http_get(format('https://sports.core.api.espn.com/v2/colleges/%s', n.college_id),
                        timeout_milliseconds := 15000) as request_id
      from need n
  ), ins as (
    insert into public.espn_colleges as c (college_id, status, request_id, requested_at, attempts)
    select college_id, 'new', request_id, now(), 1 from req
    on conflict (college_id) do update set request_id = excluded.request_id, requested_at = now(), attempts = c.attempts + 1
    returning 1
  )
  select count(*) into v_c_req from ins;

  if v_drained = 0 and v_requested = 0 and v_c_drained = 0 and v_c_req = 0 then
    return jsonb_build_object('idle', true);
  end if;

  v_ok_run := (v_errs = 0 or v_errs < v_drained / 4.0) and (v_c_errs = 0 or v_c_errs < v_c_drained / 4.0);
  perform public.log_pipeline_run(
    'espn-athlete-bio', v_started, v_drained + v_requested + v_c_drained + v_c_req, v_ok + v_c_drained - v_c_errs, 0, v_ok_run,
    case when v_errs + v_c_errs > 0
         then v_errs || ' of ' || v_drained || ' athlete and ' || v_c_errs || ' of ' || v_c_drained || ' college lookups failed' end,
    null, null, null,
    jsonb_build_object('athletes_drained', v_drained, 'athletes_answered', v_ok, 'with_dob', v_dob, 'athlete_errors', v_errs,
                       'athletes_requested', v_requested, 'colleges_drained', v_c_drained, 'college_errors', v_c_errs,
                       'colleges_requested', v_c_req, 'golazos_crosswalk', v_xwalk, 'search_crosswalk', v_sxw,
                       'targets_without_bio', (select count(*) from public.espn_bio_targets() t
                                                 left join public.espn_athlete_bio b on b.sport = t.sport and b.espn_id = t.espn_id
                                                where b.espn_id is null or b.fields_version < 3),
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return jsonb_build_object('ok', v_ok_run, 'athletes_drained', v_drained, 'athletes_answered', v_ok, 'athlete_errors', v_errs,
                            'athletes_requested', v_requested, 'colleges_drained', v_c_drained, 'college_errors', v_c_errs,
                            'colleges_requested', v_c_req, 'golazos_crosswalk', v_xwalk);
end
$$;
-- anon-exec: unchanged (espn_athlete_bio_tick) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.