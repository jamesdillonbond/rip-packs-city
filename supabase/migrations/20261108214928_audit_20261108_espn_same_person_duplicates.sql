-- audit_20261108_espn_same_person_duplicates
--
-- Two refinements to the ESPN person links, measured 2026-11-08 after the search crosswalk ran:
--
-- 1. ESPN keeps DUPLICATE athlete records for one person (Iker Casillas: 11811 and 19295, same
--    name, same date of birth). 12 of 30 "ambiguous" Golazos keys were exactly that. Several
--    candidates with ONE name (already required) and ONE date of birth are now treated as one
--    person and linked to the record the box scores use (else the lowest id):
--      · refresh_golazos_espn_crosswalk — when every era-passing candidate shares one DOB;
--      · refresh_espn_search_crosswalk (new; the UFC / Panini rebuild moved out of
--        espn_search_tick) — matched_by 'espn-search-same-person' when EVERY exact hit has a DOB
--        and there is exactly one distinct DOB. espn_bio_targets now includes every exact hit of
--        an ambiguous UFC / Panini search so those DOBs get fetched.
--    Two different people sharing a name AND an exact birth date is not a case this guards
--    against; anything short of that stays 'ambiguous'.
--
-- 2. A Golazos candidate whose unknown can never become known (ESPN states no DOB, the lookup
--    failed 3 times, or the key has no dated Golazos moment) left the key 'pending_bio' forever
--    (5 keys). It is now 'unverifiable' — still no link, but no longer reported as in progress.
--
-- espn_athlete_bio_tick also refreshes the search crosswalk when DOBs land.
--
-- Revert: re-apply the 20261108213822 bodies of espn_search_tick, espn_athlete_bio_tick and
-- espn_bio_targets and the 20261108210431 body of refresh_golazos_espn_crosswalk; then
--   drop function public.refresh_espn_search_crosswalk();
--   alter table public.espn_search_crosswalk drop constraint espn_search_crosswalk_matched_by_check,
--     add constraint espn_search_crosswalk_matched_by_check check (matched_by in ('espn-search-unique', 'ambiguous', 'too_common', 'no_match'));
--   delete from public.espn_search_crosswalk where matched_by = 'espn-search-same-person';  -- then run one espn_search_tick drain
--   select public.refresh_golazos_espn_crosswalk();

alter table public.espn_search_crosswalk drop constraint espn_search_crosswalk_matched_by_check;
alter table public.espn_search_crosswalk add constraint espn_search_crosswalk_matched_by_check
  check (matched_by in ('espn-search-unique', 'espn-search-same-person', 'ambiguous', 'too_common', 'no_match'));

create or replace function public.refresh_espn_search_crosswalk()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_out jsonb;
begin
  with s as (
    select q.collection_slug, q.name_slug, q.sport, q.player_label, q.total_found, q.exact,
           (select count(distinct x->>'espn_id') from jsonb_array_elements(q.exact) x) as n
      from public.espn_search_queue q
     where q.status = 'done' and q.collection_slug in ('ufc_strike', 'panini_blockchain')
  ), d as (
    select s.collection_slug, s.name_slug, s.sport,
           count(distinct x->>'espn_id') filter (where b.status = 'ok' and b.date_of_birth is not null) as n_dob_known,
           count(distinct b.date_of_birth) filter (where b.status = 'ok') as n_dob,
           coalesce(min(x->>'espn_id') filter (where exists (select 1 from public.espn_athletes a where a.espn_id = x->>'espn_id')),
                    min(x->>'espn_id')) as pick
      from s
     cross join lateral jsonb_array_elements(s.exact) x
      left join public.espn_athlete_bio b on b.sport = s.sport and b.espn_id = x->>'espn_id'
     where s.n > 1 and s.total_found <= 25
     group by 1, 2, 3
  ), v as (
    select s.*,
           case when s.n = 1 and s.total_found <= 25 then s.exact->0
                when d.pick is not null and d.n_dob_known = s.n and d.n_dob = 1
                  then (select x from jsonb_array_elements(s.exact) x where x->>'espn_id' = d.pick limit 1) end as hit,
           case when s.n = 1 and s.total_found <= 25 then 'espn-search-unique'
                when d.pick is not null and d.n_dob_known = s.n and d.n_dob = 1 then 'espn-search-same-person'
                when s.n > 1 then 'ambiguous'
                when s.n = 1 then 'too_common'
                else 'no_match' end as status
      from s
      left join d on d.collection_slug = s.collection_slug and d.name_slug = s.name_slug and d.sport = s.sport
  )
  insert into public.espn_search_crosswalk as c
    (collection_slug, name_slug, sport, player_label, espn_id, display_name, league_slug, matched_by, candidates, matched_at)
  select collection_slug, name_slug, sport, player_label,
         hit->>'espn_id', hit->>'name', hit->>'league',
         status,
         case when status = 'espn-search-unique' then null else exact || jsonb_build_object('total_found', total_found) end,
         now()
    from v
  on conflict (collection_slug, name_slug, sport) do update set
    player_label = excluded.player_label, espn_id = excluded.espn_id, display_name = excluded.display_name,
    league_slug = excluded.league_slug, matched_by = excluded.matched_by, candidates = excluded.candidates,
    matched_at = case when (c.espn_id, c.matched_by) is distinct from (excluded.espn_id, excluded.matched_by)
                      then now() else c.matched_at end;

  select jsonb_build_object(
           'linked', count(*) filter (where espn_id is not null),
           'same_person', count(*) filter (where matched_by = 'espn-search-same-person'),
           'ambiguous', count(*) filter (where matched_by = 'ambiguous'),
           'too_common', count(*) filter (where matched_by = 'too_common'),
           'no_match', count(*) filter (where matched_by = 'no_match'),
           'by_collection_sport', (select jsonb_object_agg(k, n) from (
               select collection_slug || ':' || sport as k, count(*) filter (where espn_id is not null) as n
                 from public.espn_search_crosswalk group by 1) t))
    into v_out from public.espn_search_crosswalk;
  return v_out;
end
$$;
-- anon-exec: revoked (refresh_espn_search_crosswalk) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.refresh_espn_search_crosswalk() from public, anon, authenticated;
grant execute on function public.refresh_espn_search_crosswalk() to postgres, service_role;

create or replace function public.espn_search_tick()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started   timestamptz := clock_timestamp();
  v_drained   int := 0;
  v_errs      int := 0;
  v_requested int := 0;
  v_xw        jsonb;
  v_ok_run    boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_search_tick')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  -- 1. Drain: total player hits + the hits whose name slug equals the key in the key's sport.
  with r as (
    select q.collection_slug, q.name_slug, q.sport, h.status_code, h.error_msg,
           case when h.status_code = 200 and not coalesce(h.timed_out, false)
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as body
      from public.espn_search_queue q
      left join net._http_response h on h.id = q.request_id
     where q.request_id is not null
       and (h.id is not null or q.requested_at < now() - interval '10 minutes')
  ), p as (
    select r.*,
           (select (t->>'totalFound')::int from jsonb_array_elements(r.body->'resultTypes') t where t->>'type' = 'player' limit 1) as total,
           (select coalesce(jsonb_agg(distinct jsonb_build_object(
                     'espn_id', substring(x->>'uid' from 'a:(\d+)$'), 'name', x->>'displayName',
                     'league', x->>'defaultLeagueSlug')), '[]'::jsonb)
              from jsonb_array_elements(coalesce(r.body->'results', '[]'::jsonb)) res
             cross join lateral jsonb_array_elements(coalesce(res->'contents', '[]'::jsonb)) x
             where res->>'type' = 'player' and x->>'sport' = r.sport
               and public.rpc_name_slug(x->>'displayName') = r.name_slug
               and substring(x->>'uid' from 'a:(\d+)$') is not null) as exact
      from r
  ), u as (
    update public.espn_search_queue q
       set status      = case when p.body is null then 'error' else 'done' end,
           total_found = case when p.body is null then q.total_found else coalesce(p.total, 0) end,
           exact       = case when p.body is null then q.exact else p.exact end,
           fetched_at  = now(),
           request_id  = null,
           last_error  = case when p.body is null
                              then left('espn search ' || coalesce(p.status_code::text, 'no-response') || ' ' || coalesce(p.error_msg, ''), 200) end
      from p
     where q.collection_slug = p.collection_slug and q.name_slug = p.name_slug and q.sport = p.sport
    returning q.status
  )
  select count(*), count(*) filter (where status = 'error') into v_drained, v_errs from u;

  -- 2. Rebuild the UFC / Panini crosswalk (also called by the bio tick once DOBs land).
  if v_drained > 0 then
    v_xw := public.refresh_espn_search_crosswalk();
  end if;

  -- 3. Dispatch: never-searched keys first; an error retries after a day, 3 tries max.
  with need as (
    select p.collection_slug, p.name_slug, p.sport, p.player_label
      from public.espn_search_population() p
      left join public.espn_search_queue q
        on q.collection_slug = p.collection_slug and q.name_slug = p.name_slug and q.sport = p.sport
     where q.name_slug is null
        or (q.request_id is null and q.status = 'error' and q.attempts < 3 and q.fetched_at < now() - interval '1 day')
     order by (q.name_slug is not null), p.collection_slug, p.name_slug
     limit 150
  ), req as (
    select n.*,
           net.http_get(format('https://site.web.api.espn.com/apis/search/v2?query=%s&limit=25&type=player',
                               replace(n.name_slug, '-', '%20')),
                        timeout_milliseconds := 15000) as request_id
      from need n
  ), ins as (
    insert into public.espn_search_queue as q (collection_slug, name_slug, sport, player_label, status, request_id, requested_at, attempts)
    select collection_slug, name_slug, sport, player_label, 'new', request_id, now(), 1 from req
    on conflict (collection_slug, name_slug, sport) do update set
      player_label = excluded.player_label, request_id = excluded.request_id, requested_at = now(), attempts = q.attempts + 1
    returning 1
  )
  select count(*) into v_requested from ins;

  if v_drained = 0 and v_requested = 0 then
    return jsonb_build_object('idle', true);
  end if;

  v_ok_run := v_errs = 0 or v_errs < v_drained / 4.0;
  perform public.log_pipeline_run(
    'espn-search-crosswalk', v_started, v_drained + v_requested, v_drained - v_errs, 0, v_ok_run,
    case when v_errs > 0 then v_errs || ' of ' || v_drained || ' ESPN searches failed' end,
    null, null, null,
    jsonb_build_object('drained', v_drained, 'errors', v_errs, 'requested', v_requested, 'crosswalk', v_xw,
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return jsonb_build_object('ok', v_ok_run, 'drained', v_drained, 'errors', v_errs, 'requested', v_requested, 'crosswalk', v_xw);
end
$$;
-- anon-exec: unchanged (espn_search_tick) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

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

create or replace function public.espn_bio_targets()
returns table (sport text, league_seg text, espn_id text)
language sql stable
set search_path = pg_catalog, public
as $$
  with t as (
    select l.sport, split_part(l.path, '/', 2) as league_seg, pi.espn_id
      from public.player_identities pi
      join public.espn_leagues l on l.league = coalesce(pi.espn_league, pi.league)
     where pi.espn_id is not null and pi.player_id is not null
    union
    select 'soccer', null, c.espn_id from public.golazos_espn_candidates() c
    union
    select x.sport,
           coalesce(
             (select split_part(l.path, '/', 2) from public.player_identities pi
                join public.espn_leagues l on l.league = coalesce(pi.espn_league, pi.league)
               where pi.espn_id = x.espn_id and l.sport = x.sport limit 1),
             (select split_part(l.path, '/', 2) from public.espn_athletes a
                join public.espn_leagues l on l.league = a.league
               where a.espn_id = x.espn_id and l.sport = x.sport limit 1),
             case x.sport when 'basketball' then 'nba' when 'football' then 'nfl' when 'baseball' then 'mlb' end),
           x.espn_id
      from public.panini_espn_crosswalk x
     where x.espn_id is not null
    union
    select s.sport, case when s.sport in ('soccer', 'mma') then null else s.league_slug end, s.espn_id
      from public.espn_search_crosswalk s
     where s.espn_id is not null
    union
    select q.sport, case when q.sport in ('soccer', 'mma') then null else x->>'league' end, x->>'espn_id'
      from public.espn_search_queue q
     cross join lateral jsonb_array_elements(q.exact) x
     where q.status = 'done' and q.total_found <= 25 and jsonb_array_length(q.exact) > 1
       and q.collection_slug in ('ufc_strike', 'panini_blockchain')
  )
  select distinct on (t.sport, t.espn_id) t.sport, t.league_seg, t.espn_id
    from t
   order by t.sport, t.espn_id, t.league_seg nulls last
$$;
-- anon-exec: unchanged (espn_bio_targets) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

create or replace function public.refresh_golazos_espn_crosswalk()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_out jsonb;
begin
  with era as (
    select public.rpc_name_slug(e.player_name) as name_slug,
           min(e.game_date)::date as first_d, max(e.game_date)::date as last_d
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.slug = 'laliga_golazos'
     where e.game_date is not null
     group by 1
  ), cand as (
    select c.name_slug, c.player_label, c.espn_id, c.espn_display_name, c.how, b.date_of_birth,
           case when b.status <> 'ok' or b.date_of_birth is null or era.first_d is null then null
                else extract(year from age(era.first_d, b.date_of_birth)) between 15 and 41
                 and extract(year from age(era.last_d, b.date_of_birth)) <= 43 end as era_ok,
           -- an unknown that will never become known: ESPN states no DOB, the lookup failed 3 times,
           -- or the key has no dated Golazos moment to test against
           (b.status = 'no_dob' or (b.status = 'error' and b.attempts >= 3) or era.first_d is null) as final_unknown,
           exists (select 1 from public.espn_athletes a where a.espn_id = c.espn_id) as in_box
      from public.golazos_espn_candidates() c
      left join public.espn_athlete_bio b on b.sport = 'soccer' and b.espn_id = c.espn_id
      left join era on era.name_slug = c.name_slug
  ), m as (
    select name_slug, max(player_label) as player_label,
           count(*) filter (where era_ok) as n_pass,
           count(*) filter (where era_ok is null and not coalesce(final_unknown, false)) as n_unknown,
           count(*) filter (where era_ok is null and coalesce(final_unknown, false)) as n_final_unknown,
           count(distinct date_of_birth) filter (where era_ok) as n_pass_dob,
           -- several ESPN records with ONE name and ONE date of birth are one person (duplicate
           -- records, e.g. Iker Casillas 11811 / 19295): prefer the record the box scores use
           coalesce(min(espn_id) filter (where era_ok and in_box), min(espn_id) filter (where era_ok)) as espn_id,
           coalesce(min(espn_display_name) filter (where era_ok and in_box), min(espn_display_name) filter (where era_ok)) as espn_display_name,
           min(how) filter (where era_ok) as how,
           jsonb_agg(jsonb_build_object('espn_id', espn_id, 'name', espn_display_name, 'how', how,
                                        'dob', date_of_birth, 'era_ok', era_ok) order by espn_id) as candidates
      from cand
     group by name_slug
  ), s as (
    select m.*,
           case when n_unknown > 0 then 'pending_bio'
                when n_pass >= 1 and n_pass_dob = 1 and n_final_unknown = 0 then how || '-name+dob-era'
                when n_pass > 1 then 'ambiguous'
                when n_final_unknown > 0 then 'unverifiable'
                else 'era_mismatch' end as status
      from m
  ), d as (
    delete from public.golazos_espn_crosswalk c where not exists (select 1 from s where s.name_slug = c.name_slug)
    returning 1
  )
  insert into public.golazos_espn_crosswalk as c (name_slug, player_label, espn_id, espn_display_name, matched_by, candidates, matched_at)
  select name_slug, player_label,
         case when status like '%-name+dob-era' then espn_id end,
         case when status like '%-name+dob-era' then espn_display_name end,
         status, candidates, now()
    from s
  on conflict (name_slug) do update set
    player_label = excluded.player_label, espn_id = excluded.espn_id, espn_display_name = excluded.espn_display_name,
    matched_by = excluded.matched_by, candidates = excluded.candidates,
    matched_at = case when (c.espn_id, c.matched_by) is distinct from (excluded.espn_id, excluded.matched_by)
                      then now() else c.matched_at end;

  select jsonb_build_object(
           'matched', count(*) filter (where espn_id is not null),
           'fuzzy', count(*) filter (where matched_by = 'fuzzy-name+dob-era'),
           'ambiguous', count(*) filter (where matched_by = 'ambiguous'),
           'era_mismatch', count(*) filter (where matched_by = 'era_mismatch'),
           'pending_bio', count(*) filter (where matched_by = 'pending_bio'),
           'unverifiable', count(*) filter (where matched_by = 'unverifiable'))
    into v_out from public.golazos_espn_crosswalk;
  return v_out;
end
$$;
-- anon-exec: unchanged (refresh_golazos_espn_crosswalk) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

select public.refresh_espn_search_crosswalk();
select public.refresh_golazos_espn_crosswalk();