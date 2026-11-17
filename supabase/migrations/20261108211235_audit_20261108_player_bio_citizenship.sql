-- audit_20261108_player_bio_citizenship
--
-- ESPN's soccer athlete records carry NO birthplace (birthPlace = {} on 218 of 225 soccer
-- athletes, measured 2026-11-08) but do carry `citizenship` (e.g. Modrić → Croatia). Citizenship is
-- NOT the country of birth and is never written into birth_country; it gets its own column, captured
-- for every sport (international NBA / NFL / MLB players too). fields_version 3 marks a row fetched
-- with it; the tick re-fetches the 3,292 version-2 rows once (status never changes while in flight,
-- so no Golazos link drops). get_player_bio returns `citizenship` beside the birthplace fields.
--
-- Revert: re-apply the 20261108210431 bodies of espn_athlete_bio_tick and get_player_bio, then
--   alter table public.espn_athlete_bio drop column citizenship;

alter table public.espn_athlete_bio add column citizenship text;

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
  end if;

  -- 3. Dispatch athletes: never fetched, fetched before birthplace/college were captured, or an
  --    error due a retry (after a day, 3 tries). Never two requests in flight for one athlete.
  --    fields_version 3 = DOB + birthplace + college + citizenship.
  with need as (
    select t.sport, t.league_seg, t.espn_id
      from public.espn_bio_targets() t
      left join public.espn_athlete_bio b on b.sport = t.sport and b.espn_id = t.espn_id
     where b.espn_id is null
        or (b.request_id is null and b.fields_version < 3 and b.status <> 'error' and b.attempts < 8)
        or (b.request_id is null and b.status = 'error' and b.attempts < 3 and b.fetched_at < now() - interval '1 day')
     order by (b.espn_id is not null), t.sport, t.espn_id
     limit 200
  ), req as (
    select n.sport, n.league_seg, n.espn_id,
           net.http_get(
             case when n.sport = 'soccer'
                  then format('https://sports.core.api.espn.com/v2/sports/soccer/athletes/%s', n.espn_id)
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
                       'colleges_requested', v_c_req, 'golazos_crosswalk', v_xwalk,
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

create or replace function public.get_player_bio(p_collection_slug text, p_slugs text[], p_player_id uuid default null)
returns jsonb language sql stable
set search_path = pg_catalog, public
as $$
  with ids as (
    select distinct l.sport, pi.espn_id
      from public.player_identities pi
      join public.collections c on c.id = pi.collection_id
      join public.espn_leagues l on l.league = coalesce(pi.espn_league, pi.league)
     where c.slug = p_collection_slug and pi.espn_id is not null
       and (case when p_player_id is not null then pi.player_id = p_player_id else pi.name_slug = any (p_slugs) end)
    union
    select 'soccer', x.espn_id
      from public.golazos_espn_crosswalk x
     where p_collection_slug = 'laliga_golazos' and x.espn_id is not null and x.name_slug = any (p_slugs)
    union
    select p.sport, p.espn_id
      from public.panini_espn_crosswalk p
     where p_collection_slug = 'panini_blockchain' and p.espn_id is not null and p.name_slug = any (p_slugs)
  ), one as (
    select b.*, col.name as college_name
      from public.espn_athlete_bio b
      join ids on ids.sport = b.sport and ids.espn_id = b.espn_id
      left join public.espn_colleges col on col.college_id = b.college_id and col.status = 'ok'
     where (select count(*) from ids) = 1 and b.status in ('ok', 'no_dob') and b.fields_version >= 2
  ), onchain as (
    select e.player_birthdate as dob, e.player_birthplace as place, count(*) as n
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.slug = 'nba_top_shot'
     where p_collection_slug = 'nba_top_shot' and p_player_id is not null and e.player_id = p_player_id
       and (e.player_birthdate is not null or e.player_birthplace is not null)
     group by 1, 2
     order by n desc
     limit 1
  ), nflverse as (
    select pi.birth_date
      from public.player_identities pi
      join public.collections c on c.id = pi.collection_id
     where p_collection_slug = 'nfl_all_day' and p_player_id is not null and pi.player_id = p_player_id
       and pi.birth_date is not null
     limit 1
  )
  select jsonb_build_object(
    'linked', (select count(*) from ids),
    'espn', (select jsonb_build_object('espn_id', espn_id, 'date_of_birth', date_of_birth, 'birth_city', birth_city,
                                       'birth_state', birth_state, 'birth_country', birth_country, 'citizenship', citizenship,
                                       'college', college_name, 'college_id', college_id, 'fetched_at', fetched_at)
               from one),
    'onchain', (select jsonb_build_object('date_of_birth', dob, 'birthplace', place) from onchain),
    'nflverse_date_of_birth', (select birth_date from nflverse))
$$;
-- anon-exec: unchanged (get_player_bio) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.