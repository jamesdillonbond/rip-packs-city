-- audit_20261108_espn_more_soccer_leagues_athlete_bio
--
-- Two additions to the ESPN game-log lane (2026-11-08):
--
-- 1. Six more soccer leagues, each probed from pg_net first (200 with events, summaries carry
--    rosters[] with stats): Saudi Pro League (ksa.1 — Benzema, Cristiano Ronaldo, João Félix,
--    Bounou, Iñigo Martínez, En-Nesyri, Carrasco), Brasileirão (bra.1 — Neymar, Gonzalo Plata),
--    Argentina (arg.1 — Di María, Muniain, Acuña), Liga MX (mex.1 — Ángel Correa), Süper Lig
--    (tur.1 — Asensio) and the Russian Premier League (rus.1 — Luiz Henrique). Golazos players who
--    left LaLiga play there. Qatar (qat.1) answered 400 and is left out. One espn_leagues row +
--    one espn_gamelog_backfill_state row each; every lane function already reads the table.
--
-- 2. ESPN athlete date of birth (espn_athlete_bio), so the Golazos crosswalk can REFUSE a name
--    match that is the wrong person. Golazos is full of retired legends (Raúl, Xavi, Ronaldo,
--    Zidane …) and every new league adds active namesakes; a unique name in ESPN's box scores is
--    not proof of identity when the Golazos moment is from 2008 and the ESPN athlete was born in
--    2003. espn_athlete_bio_tick() drains the previous tick's responses and requests DOB from
--    sports.core.api.espn.com for every Golazos candidate that has none (60 per tick), every 10
--    minutes at :02. Set-based — no per-row exception handler. It logs pipeline
--    `espn-athlete-bio` only on a tick that did work; it legitimately idles once every candidate
--    has a DOB, so it is NOT on the cadence watchlist (silence there is success, not failure).
--
--    golazos_espn_candidates() is the ONE place a Golazos key meets ESPN names: exact slug
--    (display or full name) or, only for a key with no exact candidate, a fuzzy rule — same last
--    name token (>= 4 chars) and the same first 4 letters of the first token ("Abde" ↔
--    "Abdessamad", "Gabri" ↔ "Gabriel", "Yéremy" ↔ "Yeremi", "José María Giménez" ↔ "José
--    Giménez"). The refresh that USES it, with the date-of-birth era test, is the next migration.
--
-- Revert:
--   select cron.unschedule('rpc-espn-athlete-bio');
--   drop function public.espn_athlete_bio_tick(); drop function public.golazos_espn_candidates();
--   drop table public.espn_athlete_bio;
--   delete from public.player_game_stats where league in ('saudi','brasileirao','argentina','ligamx','superlig','rpl');
--   delete from public.espn_game_events where league in (same list);
--   delete from public.espn_athletes where league in (same list);
--   delete from public.espn_gamelog_backfill_state where league in (same list);
--   delete from public.espn_leagues where league in (same list);

insert into public.espn_leagues (league, path, sport, backfill_floor) values
  ('saudi',       'soccer/ksa.1', 'soccer', date '2026-10-01'),
  ('brasileirao', 'soccer/bra.1', 'soccer', date '2026-10-01'),
  ('argentina',   'soccer/arg.1', 'soccer', date '2026-10-01'),
  ('ligamx',      'soccer/mex.1', 'soccer', date '2026-10-01'),
  ('superlig',    'soccer/tur.1', 'soccer', date '2026-10-01'),
  ('rpl',         'soccer/rus.1', 'soccer', date '2026-10-01');

insert into public.espn_gamelog_backfill_state (league, cursor_date, floor_date)
select l.league, (now() at time zone 'America/Los_Angeles')::date - 2, l.backfill_floor
  from public.espn_leagues l
 where not exists (select 1 from public.espn_gamelog_backfill_state b where b.league = l.league);

create table public.espn_athlete_bio (
  espn_id       text primary key,
  date_of_birth date,
  status        text not null default 'requested' check (status in ('requested', 'ok', 'no_dob', 'error')),
  request_id    bigint,
  requested_at  timestamptz,
  fetched_at    timestamptz,
  attempts      int not null default 0,
  last_error    text
);
alter table public.espn_athlete_bio enable row level security;
revoke all on public.espn_athlete_bio from anon, authenticated;

create or replace function public.golazos_espn_candidates()
returns table (name_slug text, player_label text, espn_id text, espn_display_name text, how text)
language sql stable
set search_path = pg_catalog, public
as $$
  with g as (
    select m.group_key as name_slug, max(m.group_label) as player_label
      from public.market_cap_current m
     where m.collection_slug = 'laliga_golazos' and m.grain = 'player' and m.is_primary
     group by m.group_key
  ), e as (
    select distinct a.espn_id, a.display_name, s.slug
      from public.espn_athletes a
      join public.espn_leagues l on l.league = a.league and l.sport = 'soccer'
     cross join lateral (select distinct x from unnest(array[public.rpc_name_slug(a.display_name),
                                                             public.rpc_name_slug(a.full_name)]) x
                          where x is not null) s(slug)
  ), ex as (
    select g.name_slug, g.player_label, e.espn_id, e.display_name, 'exact'::text as how
      from g join e on e.slug = g.name_slug
  ), fz as (
    select g.name_slug, g.player_label, e.espn_id, e.display_name, 'fuzzy'::text as how
      from g
      join e on e.slug like '%-%' and g.name_slug like '%-%'
            and substring(e.slug from '[^-]+$') = substring(g.name_slug from '[^-]+$')
            and length(substring(g.name_slug from '[^-]+$')) >= 4
            and length(split_part(g.name_slug, '-', 1)) >= 4 and length(split_part(e.slug, '-', 1)) >= 4
            and left(split_part(e.slug, '-', 1), 4) = left(split_part(g.name_slug, '-', 1), 4)
     where not exists (select 1 from ex where ex.name_slug = g.name_slug)
  )
  select distinct on (name_slug, espn_id) name_slug, player_label, espn_id, display_name, how
    from (select * from ex union all select * from fz) c
   order by name_slug, espn_id, how
$$;
-- anon-exec: revoked (golazos_espn_candidates) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.golazos_espn_candidates() from public, anon, authenticated;
grant execute on function public.golazos_espn_candidates() to postgres, service_role;

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
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return jsonb_build_object('ok', v_ok_run, 'drained', v_drained, 'stored', v_ok, 'errors', v_errs, 'requested', v_requested);
end
$$;
-- anon-exec: revoked (espn_athlete_bio_tick) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_athlete_bio_tick() from public, anon, authenticated;
grant execute on function public.espn_athlete_bio_tick() to postgres, service_role;

select cron.schedule('rpc-espn-athlete-bio', '2,12,22,32,42,52 * * * *', 'select public.espn_athlete_bio_tick()');