-- audit_20261108_golazos_crosswalk_dob_era
--
-- The Golazos → ESPN crosswalk now proves the person, not just the name (2026-11-08).
--
-- Before: a Golazos player key matched when exactly one ESPN soccer athlete in the box scores
-- carried that name. With 18 leagues ingested, a retired legend's name (Raúl, Pedro, Joaquín …)
-- can belong to exactly one ACTIVE player somewhere — a unique name, the wrong person, and that
-- stranger's games would render on the legend's page. After: candidates come from
-- golazos_espn_candidates() (exact name, or the narrow fuzzy rule for a key with no exact
-- candidate), and each must pass a DATE-OF-BIRTH ERA TEST against the Golazos moments themselves:
-- the athlete was 15–41 at the player's FIRST Golazos moment and at most 43 at the LAST. A link is
-- written only when exactly one candidate passes and no candidate's DOB is still unknown.
--
--   matched_by          exact-name+dob-era | fuzzy-name+dob-era   (espn_id set)
--   ambiguous           more than one candidate passes            (espn_id null, candidates listed)
--   era_mismatch        every candidate's DOB rules it out        (espn_id null)
--   pending_bio         a candidate has no DOB yet, or the key has no dated Golazos moment
--
-- Measured before apply (dry run): all 125 current candidates have a DOB; every existing unique
-- match passes the era test (no wrong-person link existed); the fuzzy rule adds 4 (Abde
-- Ezzalzouli, Gabri Veiga, José María Giménez, Yéremy Pino); luis-suarez stays ambiguous (the
-- Uruguayan b.1987 and the Colombian b.1997 both pass — the era cannot separate them).
-- espn_athlete_bio_tick() now refreshes the crosswalk after storing any DOB.
--
-- Revert: re-apply the 20261108183002 body of refresh_golazos_espn_crosswalk and the
-- 20261108201432 body of espn_athlete_bio_tick, then `select public.refresh_golazos_espn_crosswalk();`.

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
           case when b.date_of_birth is null or era.first_d is null then null
                else extract(year from age(era.first_d, b.date_of_birth)) between 15 and 41
                 and extract(year from age(era.last_d, b.date_of_birth)) <= 43 end as era_ok
      from public.golazos_espn_candidates() c
      left join public.espn_athlete_bio b on b.espn_id = c.espn_id and b.status = 'ok'
      left join era on era.name_slug = c.name_slug
  ), m as (
    select name_slug, max(player_label) as player_label,
           count(*) filter (where era_ok) as n_pass,
           count(*) filter (where era_ok is null) as n_unknown,
           min(espn_id) filter (where era_ok) as espn_id,
           min(espn_display_name) filter (where era_ok) as espn_display_name,
           min(how) filter (where era_ok) as how,
           jsonb_agg(jsonb_build_object('espn_id', espn_id, 'name', espn_display_name, 'how', how,
                                        'dob', date_of_birth, 'era_ok', era_ok) order by espn_id) as candidates
      from cand
     group by name_slug
  ), s as (
    select m.*,
           case when n_pass = 1 and n_unknown = 0 then how || '-name+dob-era'
                when n_pass > 1 then 'ambiguous'
                when n_unknown > 0 then 'pending_bio'
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
           'pending_bio', count(*) filter (where matched_by = 'pending_bio'))
    into v_out from public.golazos_espn_crosswalk;
  return v_out;
end
$$;
-- anon-exec: unchanged (refresh_golazos_espn_crosswalk) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

create or replace function public.espn_athlete_bio_tick()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started   timestamptz := clock_timestamp();
  v_drained   int := 0;
  v_ok        int := 0;
  v_errs      int := 0;
  v_requested int := 0;
  v_ok_run    boolean;
  v_xwalk     jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_athlete_bio_tick')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  -- 1. Drain: a response that arrived, or a request older than 10 minutes with none (an error).
  with r as (
    select b.espn_id, h.status_code, h.timed_out, h.error_msg,
           case when h.status_code = 200 and not coalesce(h.timed_out, false)
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as body
      from public.espn_athlete_bio b
      left join net._http_response h on h.id = b.request_id
     where b.status = 'requested'
       and (h.id is not null or b.requested_at < now() - interval '10 minutes')
  ), p as (
    select r.espn_id, r.body, r.status_code, r.error_msg,
           case when r.body->>'dateOfBirth' ~ '^\d{4}-\d{2}-\d{2}' then left(r.body->>'dateOfBirth', 10)::date end as dob
      from r
  ), u as (
    update public.espn_athlete_bio b
       set status        = case when p.body is null then 'error' when p.dob is null then 'no_dob' else 'ok' end,
           date_of_birth = p.dob,
           fetched_at    = now(),
           last_error    = case when p.body is null
                                then left('espn core ' || coalesce(p.status_code::text, 'no-response') || ' ' || coalesce(p.error_msg, ''), 200) end
      from p
     where b.espn_id = p.espn_id
    returning b.status
  )
  select count(*), count(*) filter (where status in ('ok', 'no_dob')), count(*) filter (where status = 'error')
    into v_drained, v_ok, v_errs from u;

  -- A stored DOB can settle a pending Golazos link: refresh before dispatching more.
  if v_ok > 0 then
    v_xwalk := public.refresh_golazos_espn_crosswalk();
  end if;

  -- 2. Dispatch: every Golazos candidate with no DOB yet; an error retries after a day, 3 tries max.
  with need as (
    select distinct c.espn_id
      from public.golazos_espn_candidates() c
      left join public.espn_athlete_bio b on b.espn_id = c.espn_id
     where b.espn_id is null
        or (b.status = 'error' and b.attempts < 3 and b.fetched_at < now() - interval '1 day')
     order by c.espn_id
     limit 60
  ), req as (
    select n.espn_id,
           net.http_get(format('https://sports.core.api.espn.com/v2/sports/soccer/athletes/%s', n.espn_id),
                        timeout_milliseconds := 15000) as request_id
      from need n
  ), ins as (
    insert into public.espn_athlete_bio as b (espn_id, status, request_id, requested_at, attempts)
    select espn_id, 'requested', request_id, now(), 1 from req
    on conflict (espn_id) do update set
      status = 'requested', request_id = excluded.request_id, requested_at = now(), attempts = b.attempts + 1
    returning 1
  )
  select count(*) into v_requested from ins;

  if v_drained = 0 and v_requested = 0 then
    return jsonb_build_object('idle', true);
  end if;

  v_ok_run := v_errs = 0 or v_errs < v_drained / 4.0;
  perform public.log_pipeline_run(
    'espn-athlete-bio', v_started, v_drained + v_requested, v_drained, 0, v_ok_run,
    case when v_errs > 0 then v_errs || ' of ' || v_drained || ' athlete lookups failed' end,
    null, null, null,
    jsonb_build_object('drained', v_drained, 'stored', v_ok, 'errors', v_errs, 'requested', v_requested,
                       'golazos_crosswalk', v_xwalk,
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return jsonb_build_object('ok', v_ok_run, 'drained', v_drained, 'stored', v_ok, 'errors', v_errs,
                            'requested', v_requested, 'golazos_crosswalk', v_xwalk);
end
$$;
-- anon-exec: unchanged (espn_athlete_bio_tick) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

select public.refresh_golazos_espn_crosswalk();