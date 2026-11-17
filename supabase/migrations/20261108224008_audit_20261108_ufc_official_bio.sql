-- audit_20261108_ufc_official_bio
--
-- UFC fighters' place and date of birth from UFC.com, the league's own athlete pages (2026-11-08).
-- ESPN's MMA records carry citizenship but no birthplace (measured: sports.core and common/v3 both
-- return an empty birthPlace for every fighter sampled), and the UFC Strike chain metadata carries
-- name / weight class / event only. Trevor asked for official, non-crowdsourced sources only, so
-- Wikidata / Wikipedia / fan databases are out.
--
-- ufc.com/robots.txt allows /athlete/ with crawl-delay 15, so the lane dispatches ONE request per
-- 20-second tick (386 fighters ≈ 2.2 h, then idle). pg_net follows redirects — an unknown slug
-- lands on /search with HTTP 200 — so a fetch counts only when the page's own JSON-LD Person url is
-- an /athlete/ page.
--
-- A name is not a person: the UFC.com page is used only when a second source agrees —
--   ufc-dob-agrees       the linked ESPN record states the same date of birth, or
--   ufc-event-confirmed  the athlete page's fight history names an event this fighter's UFC Strike
--                        moments come from (UFC <n>, or a Fight Night on the same date).
-- An ESPN DOB that DISAGREES is 'dob_conflict' and nothing is published.
-- Verdicts are materialised into player_official_bio (source 'ufc.com'), which get_player_bio reads.
--
-- Revert: select cron.unschedule('rpc-ufc-athlete-bio'); drop function public.ufc_athlete_bio_tick();
--   drop function public.refresh_ufc_official_bio(); drop table public.ufc_athlete_bio;
--   delete from public.player_official_bio where source = 'ufc.com';

create table if not exists public.player_official_bio (
  collection_slug text not null,
  name_slug       text not null,
  source          text not null check (source in ('ufc.com', 'laliga.com')),
  source_url      text not null,
  source_name     text,
  date_of_birth   date,
  birth_place     text,
  birth_country   text,
  verified_by     text not null,
  fetched_at      timestamptz not null,
  updated_at      timestamptz not null default now(),
  primary key (collection_slug, name_slug, source)
);
alter table public.player_official_bio enable row level security;
revoke all on public.player_official_bio from anon, authenticated;
comment on table public.player_official_bio is
  'Birth date/place from a league''s own athlete page (UFC.com, LALIGA), each row identity-verified by a second source (verified_by). Read by get_player_bio. 20261108.';

create table if not exists public.ufc_athlete_bio (
  name_slug      text primary key,
  player_label   text not null,
  ufc_slug       text not null,
  status         text not null default 'pending' check (status in ('pending', 'queued', 'ok', 'not_found', 'error')),
  attempts       int not null default 0,
  request_id     bigint,
  http_status    int,
  page_url       text,
  page_name      text,
  date_of_birth  date,
  birth_place    text,
  division       text,
  event_numbers  int[],
  event_dates    date[],
  dispatched_at  timestamptz,
  fetched_at     timestamptz
);
alter table public.ufc_athlete_bio enable row level security;
revoke all on public.ufc_athlete_bio from anon, authenticated;

create or replace function public.refresh_ufc_official_bio()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare v_out jsonb;
begin
  with ours as (
    -- The events this fighter's UFC Strike moments come from.
    select public.rpc_name_slug(e.player_name) as name_slug,
           array_agg(distinct (substring(e.set_name from '^UFC ([0-9]{2,3}) '))::int)
             filter (where e.set_name ~ '^UFC [0-9]{2,3} ') as nums,
           array_agg(distinct to_date(
               substring(e.set_name from 'FIGHT NIGHT ([A-Z]{3})[A-Z]* [0-9]{1,2} [0-9]{4}') || ' ' ||
               substring(e.set_name from 'FIGHT NIGHT [A-Z]+ ([0-9]{1,2} [0-9]{4})'), 'MON DD YYYY'))
             filter (where e.set_name ~ 'FIGHT NIGHT [A-Z]+ [0-9]{1,2} [0-9]{4}') as dates
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.slug = 'ufc_strike'
     group by 1
  ), espn as (
    select x.name_slug, b.date_of_birth
      from public.espn_search_crosswalk x
      join public.espn_athlete_bio b on b.sport = 'mma' and b.espn_id = x.espn_id and b.status = 'ok'
     where x.collection_slug = 'ufc_strike' and x.espn_id is not null
  ), v as (
    select u.*,
           case when espn.date_of_birth is not null and u.date_of_birth is not null and espn.date_of_birth <> u.date_of_birth then 'dob_conflict'
                when espn.date_of_birth is not null and espn.date_of_birth = u.date_of_birth then 'ufc-dob-agrees'
                when u.event_numbers && ours.nums or u.event_dates && ours.dates then 'ufc-event-confirmed'
                else 'unverified' end as verdict
      from public.ufc_athlete_bio u
      left join ours on ours.name_slug = u.name_slug
      left join espn on espn.name_slug = u.name_slug
     where u.status = 'ok'
  ), up as (
    insert into public.player_official_bio as o
      (collection_slug, name_slug, source, source_url, source_name, date_of_birth, birth_place, birth_country, verified_by, fetched_at)
    select 'ufc_strike', name_slug, 'ufc.com', page_url, page_name, date_of_birth, birth_place,
           nullif(trim(regexp_replace(birth_place, '^.*,', '')), ''), verdict, fetched_at
      from v
     where verdict in ('ufc-dob-agrees', 'ufc-event-confirmed') and (date_of_birth is not null or birth_place is not null)
    on conflict (collection_slug, name_slug, source) do update set
      source_url = excluded.source_url, source_name = excluded.source_name, date_of_birth = excluded.date_of_birth,
      birth_place = excluded.birth_place, birth_country = excluded.birth_country, verified_by = excluded.verified_by,
      fetched_at = excluded.fetched_at, updated_at = now()
    returning 1
  ), del as (
    -- A fighter whose verdict fell away (re-fetched, now conflicting) stops being published.
    delete from public.player_official_bio o
     where o.source = 'ufc.com'
       and not exists (select 1 from v where v.name_slug = o.name_slug and v.verdict in ('ufc-dob-agrees', 'ufc-event-confirmed')
                         and (v.date_of_birth is not null or v.birth_place is not null))
    returning 1
  )
  select jsonb_build_object(
           'published', (select count(*) from up), 'retired', (select count(*) from del),
           'verdicts', (select jsonb_object_agg(verdict, n) from (select verdict, count(*) n from v group by 1) t))
    into v_out;
  return v_out;
end
$$;
revoke all on function public.refresh_ufc_official_bio() from public, anon, authenticated;
-- anon-exec: revoked (refresh_ufc_official_bio) — new fn; REVOKE FROM PUBLIC, anon, authenticated; owner-only; verified anon=false via has_function_privilege 2026-11-08.

create or replace function public.ufc_athlete_bio_tick()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_drained int := 0;
  v_slug text;
  v_ufc text;
  v_req bigint;
begin
  if not pg_try_advisory_xact_lock(hashtext('ufc_athlete_bio_tick')) then
    return jsonb_build_object('skipped', 'locked');
  end if;

  insert into public.ufc_athlete_bio (name_slug, player_label, ufc_slug)
  select public.rpc_name_slug(p.name), max(p.name::text), public.rpc_name_slug(p.name)
    from public.players p
    join public.collections c on c.id = p.collection_id and c.slug = 'ufc_strike'
   where public.rpc_name_slug(p.name) is not null
   group by 1
  on conflict (name_slug) do nothing;

  -- Drain: responses to earlier ticks' requests (pg_net sends at commit).
  with r as (
    select b.name_slug, h.status_code, h.content,
           substring(h.content from '"url":\s*"(https://www\.ufc\.com/athlete/[^"]+)"') as page_url,
           -- The fighter's own record only (results cards + Fight History); the page head carries
           -- site-wide promos for upcoming events (e.g. a JSON-LD subjectOf "UFC 329" on every page).
           substr(h.content, nullif(strpos(h.content, 'athlete-results'), 0)) as tail
      from public.ufc_athlete_bio b
      join net._http_response h on h.id = b.request_id
     where b.status = 'queued'
  ), d as (
    update public.ufc_athlete_bio b set
      http_status = r.status_code,
      status = case when r.status_code = 200 and r.page_url is not null then 'ok'
                    when r.status_code in (200, 404) then 'not_found'
                    when b.attempts >= 3 then 'error'
                    else 'pending' end,
      page_url = r.page_url,
      page_name = case when r.page_url is not null then trim(substring(r.content from '<h1[^>]*>\s*([^<]+?)\s*<')) end,
      date_of_birth = case when r.page_url is not null and substring(r.content from '"birthDate":\s*"([0-9]{4}-[0-9]{2}-[0-9]{2})"') is not null
                           then substring(r.content from '"birthDate":\s*"([0-9]{4}-[0-9]{2}-[0-9]{2})"')::date end,
      birth_place = case when r.page_url is not null
                         then nullif(trim(substring(r.content from 'Place of Birth</div>\s*<div class="c-bio__text">([^<]*)</div>')), '') end,
      division = case when r.page_url is not null then trim(substring(r.content from '>\s*([A-Za-z'' ]+ Division)\s*<')) end,
      event_numbers = case when r.page_url is not null then
                        (select array_agg(distinct m[1]::int) from regexp_matches(r.tail, 'UFC ([0-9]{2,3})(?![0-9])', 'g') m) end,
      event_dates = case when r.page_url is not null then
                        (select array_agg(distinct d) from (
                           select to_date(replace(replace(m[1], 'Sept', 'Sep'), '.', ''), 'Mon DD, YYYY') as d
                             from regexp_matches(r.tail, '((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.? [0-9]{1,2}, (?:19|20)[0-9]{2})', 'g') m
                           union
                           select to_date(m[1], 'MM/DD/YY')
                             from regexp_matches(r.tail, '\(([0-9]{1,2}/[0-9]{1,2}/[0-9]{2})\)', 'g') m) t) end,
      fetched_at = now(),
      request_id = null
    from r
    where r.name_slug = b.name_slug
    returning 1
  )
  select count(*) into v_drained from d;

  -- A request whose response never arrived (pg_net drops after its TTL) goes back to the queue.
  update public.ufc_athlete_bio
     set status = case when attempts >= 3 then 'error' else 'pending' end, request_id = null
   where status = 'queued' and dispatched_at < now() - interval '15 minutes';

  -- Dispatch ONE (robots.txt crawl-delay 15; this runs every 20 s).
  select name_slug, ufc_slug into v_slug, v_ufc
    from public.ufc_athlete_bio
   where status = 'pending'
   order by attempts, name_slug
   limit 1;
  if v_slug is not null then
    v_req := net.http_get('https://www.ufc.com/athlete/' || v_ufc,
                          headers := '{"User-Agent":"Mozilla/5.0 (compatible; RipPacksCity/1.0; +https://www.rippackscity.com)"}'::jsonb,
                          timeout_milliseconds := 30000);
    update public.ufc_athlete_bio
       set status = 'queued', request_id = v_req, attempts = attempts + 1, dispatched_at = now()
     where name_slug = v_slug;
  end if;

  if v_drained > 0 then perform public.refresh_ufc_official_bio(); end if;
  return jsonb_build_object('drained', v_drained, 'dispatched', v_slug);
end
$$;
revoke all on function public.ufc_athlete_bio_tick() from public, anon, authenticated;
-- anon-exec: revoked (ufc_athlete_bio_tick) — new fn; REVOKE FROM PUBLIC, anon, authenticated; owner-only; verified anon=false via has_function_privilege 2026-11-08.

select cron.schedule('rpc-ufc-athlete-bio', '20 seconds', 'select public.ufc_athlete_bio_tick()');
