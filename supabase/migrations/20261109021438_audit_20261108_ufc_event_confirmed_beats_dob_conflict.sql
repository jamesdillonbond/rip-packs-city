-- audit_20261108_ufc_event_confirmed_beats_dob_conflict
--
-- A UFC.com page whose fight history lists the card's own event is the card's fighter. Until now an ESPN
-- date of birth that differed (by a day for most: Jailton Almeida 06-26 vs 06-28, Khamzat Chimaev, Nate
-- Landwehr; a year for Misha Cirkunov; five days for Rampage Jackson) withheld the WHOLE row, birthplace
-- included. Now the event confirmation publishes it, and the player page shows ESPN's date with
-- "UFC.com says …" beside it — a disagreeing source named, never hidden (lib/player-bio.ts). A conflict
-- WITHOUT event confirmation still publishes nothing (Forrest Griffin, Jens Pulver, Yoel Romero, Fabricio
-- Werdum: their UFC.com history does not list the card's event).
-- Also: the retire step is scoped to ufc_strike (it filtered on source only — the same latent defect as
-- refresh_laliga_official_bio, 20261109010906).
-- Base: live prosrc md5 19747a872dbaee89c2e0d9b4586e8767 (= 20261108225053 body), re-read 2026-11-08.
--
-- Revert: re-apply the 20261108225053 body of refresh_ufc_official_bio, then select public.refresh_ufc_official_bio();

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
           case when espn.date_of_birth is not null and espn.date_of_birth = u.date_of_birth then 'ufc-dob-agrees'
                -- The fighter's own UFC.com fight history lists this card's event: the page IS the card's
                -- fighter even where ESPN states a different date of birth. Published; the player page shows
                -- ESPN's date with "UFC.com says …" beside it (2026-11-08: Rampage Jackson, Misha Cirkunov …).
                when u.event_numbers && ours.nums
                  -- ±1 day: an event abroad carries its local date on UFC.com (Fight Island 2020-07-26 is
                  -- the set's "JULY 25 2020" — Alex Oliveira, measured 2026-11-08).
                  or exists (select 1 from unnest(u.event_dates) ud, unnest(ours.dates) od where abs(ud - od) <= 1)
                  then 'ufc-event-confirmed'
                when espn.date_of_birth is not null and u.date_of_birth is not null then 'dob_conflict'
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
     where o.source = 'ufc.com' and o.collection_slug = 'ufc_strike'
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
-- anon-exec: unchanged (refresh_ufc_official_bio) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

select public.refresh_ufc_official_bio();
