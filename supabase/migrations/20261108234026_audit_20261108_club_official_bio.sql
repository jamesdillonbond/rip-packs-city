-- audit_20261108_club_official_bio
--
-- Golazos legends LALIGA has no page for (Ronaldinho, Zidane's birthplace, Raúl, Roberto Carlos, Kaká,
-- van Nistelrooy, Bale, Özil, Deco, Abidal, Bojan …) get their place and date of birth from the CLUB's
-- own official site: realmadrid.com "football legends" (344 pages, listed in the club's
-- sitemap_legends_routes; JSON-LD birthDate / birthPlace, identical to the visible "Date of birth"
-- on all 343 that carry one) and fcbarcelona.com Barça Legends pages ("Place of birth" / "Date of
-- birth"). Read once, politely (1 req/s), by scripts/bio/club-legend-pages.py; snapshot
-- docs/research/club-legend-pages-2026-11-08.json, loaded md5-checked via pg_net.
-- Identity (club_player_candidates, decided in Python, re-checked here): the moment's on-chain team
-- (MatchHighlightedTeam) IS that club; the name matches inside that club's own list (surname tokens,
-- or given name + a surname token, or the known name = the page's slug — ties broken by every
-- given-name token, Roberto Carlos vs Zé Roberto); age 15–41 at the match dates. Published only where
-- no ESPN DOB contradicts it, every PlayerDataID behind the slug resolved to one DOB, and NO other
-- official row (LALIGA) exists for the slug — one official source per page, LALIGA first.
-- Measured 2026-11-08: Real Madrid's own page states Kaká's DOB as 21/04/1982 — shown as the club states it.
-- Base for refresh_laliga_official_bio: the 20261108231303 body (applied this session).
--
-- Revert: re-apply the 20261108231303 body of refresh_laliga_official_bio;
--   drop function public.refresh_club_official_bio(); drop table public.club_player_candidates;
--   delete from public.player_official_bio where source in ('realmadrid.com', 'fcbarcelona.com');
--   then restore the source CHECK to ('ufc.com', 'laliga.com').

alter table public.player_official_bio drop constraint player_official_bio_source_check;
alter table public.player_official_bio add constraint player_official_bio_source_check
  check (source in ('ufc.com', 'laliga.com', 'realmadrid.com', 'fcbarcelona.com'));

create table if not exists public.club_player_candidates (
  player_data_id  text not null,
  play_ids        int[] not null,
  source          text not null check (source in ('realmadrid.com', 'fcbarcelona.com')),
  source_url      text not null,
  page_name       text,
  date_of_birth   date,
  birth_place     text,
  fetched_at      timestamptz not null default now(),
  primary key (player_data_id, source)
);
alter table public.club_player_candidates enable row level security;
revoke all on public.club_player_candidates from anon, authenticated;
comment on table public.club_player_candidates is
  'Club official legend pages (realmadrid.com, fcbarcelona.com) matched to a Golazos PlayerDataID by club + name + era. refresh_club_official_bio() decides. 20261108.';

create or replace function public.refresh_club_official_bio()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare v_out jsonb;
begin
  with keys as (
    select distinct g.player_data_id, public.rpc_name_slug(e.player_name) as name_slug
      from public.golazos_play_player g
      join public.editions e on e.play_id_onchain = g.play_id
      join public.collections col on col.id = e.collection_id and col.slug = 'laliga_golazos'
  ), espn as (
    select x.name_slug, b.date_of_birth
      from public.golazos_espn_crosswalk x
      join public.espn_athlete_bio b on b.sport = 'soccer' and b.espn_id = x.espn_id and b.status = 'ok'
     where x.espn_id is not null
  ), ok as (
    select c.*, k.name_slug
      from public.club_player_candidates c
      join keys k on k.player_data_id = c.player_data_id
      left join espn on espn.name_slug = k.name_slug
     where c.date_of_birth is not null and (espn.date_of_birth is null or espn.date_of_birth = c.date_of_birth)
  ), n as (
    select o.name_slug, count(distinct o.date_of_birth) as n_dob
      from ok o
     group by o.name_slug
    having count(distinct o.player_data_id) = (select count(distinct k.player_data_id) from keys k where k.name_slug = o.name_slug)
  ), pick as (
    select distinct on (o.name_slug) o.*
      from ok o join n on n.name_slug = o.name_slug and n.n_dob = 1
     where not exists (select 1 from public.player_official_bio t
                        where t.collection_slug = 'laliga_golazos' and t.name_slug = o.name_slug
                          and t.source not in ('realmadrid.com', 'fcbarcelona.com'))
     order by o.name_slug, (o.birth_place is null), o.source
  ), up as (
    insert into public.player_official_bio as t
      (collection_slug, name_slug, source, source_url, source_name, date_of_birth, birth_place, birth_country, verified_by, fetched_at)
    select 'laliga_golazos', p.name_slug, p.source, p.source_url, p.page_name, p.date_of_birth, p.birth_place, null,
           'club-page-team-name-era', p.fetched_at
      from pick p
    on conflict (collection_slug, name_slug, source) do update set
      source_url = excluded.source_url, source_name = excluded.source_name, date_of_birth = excluded.date_of_birth,
      birth_place = excluded.birth_place, verified_by = excluded.verified_by, fetched_at = excluded.fetched_at, updated_at = now()
    returning 1
  ), del as (
    delete from public.player_official_bio t
     where t.source in ('realmadrid.com', 'fcbarcelona.com')
       and not exists (select 1 from pick p where p.name_slug = t.name_slug and p.source = t.source)
    returning 1
  )
  select jsonb_build_object('published', (select count(*) from up), 'retired', (select count(*) from del),
                            'candidates', (select count(*) from public.club_player_candidates))
    into v_out;
  return v_out;
end
$$;
revoke all on function public.refresh_club_official_bio() from public, anon, authenticated;
-- anon-exec: revoked (refresh_club_official_bio) — new fn; REVOKE FROM PUBLIC, anon, authenticated; owner-only; verified anon=false via has_function_privilege 2026-11-08.

create or replace function public.refresh_laliga_official_bio()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare v_out jsonb;
begin
  with keys as (
    -- PlayerDataID -> the Golazos name slug(s) the player page uses (via the on-chain play id).
    select distinct g.player_data_id, public.rpc_name_slug(e.player_name) as name_slug
      from public.golazos_play_player g
      join public.editions e on e.play_id_onchain = g.play_id
      join public.collections col on col.id = e.collection_id and col.slug = 'laliga_golazos'
  ), espn as (
    select x.name_slug, b.date_of_birth
      from public.golazos_espn_crosswalk x
      join public.espn_athlete_bio b on b.sport = 'soccer' and b.espn_id = x.espn_id and b.status = 'ok'
     where x.espn_id is not null
  ), ok as (
    select c.*, k.name_slug
      from public.laliga_player_candidates c
      join keys k on k.player_data_id = c.player_data_id
      left join espn on espn.name_slug = k.name_slug
     where c.verified_by = 'laliga-id'
        or (c.verified_by in ('laliga-name-dob-espn', 'laliga-name-country-era') and c.date_of_birth is not null
            and not exists (select 1 from public.laliga_player_candidates i
                             where i.player_data_id = c.player_data_id and i.verified_by = 'laliga-id')
            and (c.date_of_birth = espn.date_of_birth
                 -- strict name + nationality + era: allowed where ESPN states no DOB, never against one
                 or (c.verified_by = 'laliga-name-country-era' and espn.date_of_birth is null)))
  ), n as (
    -- One LALIGA person per name slug: one DOB across every row behind it.
    -- And every PlayerDataID behind the slug must have resolved: a slug like "ronaldo" or "pedro"
    -- that covers two players is never answered for one of them.
    -- Every row here already matched the chain's name, so the same DOB is the same person even when
    -- LALIGA spells the name two ways ("Imanol Agirretxe" / "Imanol Agirretxe Arruti", 2026-11-08).
    select o.name_slug, count(distinct o.date_of_birth) as n_people
      from ok o
     group by o.name_slug
    having count(distinct o.player_data_id) = (select count(distinct k.player_data_id) from keys k where k.name_slug = o.name_slug)
  ), pick as (
    select distinct on (o.name_slug) o.*
      from ok o join n on n.name_slug = o.name_slug and n.n_people = 1
     where o.date_of_birth is not null or o.birth_place is not null
     order by o.name_slug, (o.birth_place is null), (o.verified_by <> 'laliga-id'), o.laliga_slug
  ), up as (
    insert into public.player_official_bio as t
      (collection_slug, name_slug, source, source_url, source_name, date_of_birth, birth_place, birth_country, verified_by, fetched_at)
    select 'laliga_golazos', p.name_slug, 'laliga.com', 'https://www.laliga.com/en-ES/player/' || p.laliga_slug,
           p.laliga_name, p.date_of_birth, p.birth_place, null, p.verified_by, p.fetched_at
      from pick p
    on conflict (collection_slug, name_slug, source) do update set
      source_url = excluded.source_url, source_name = excluded.source_name, date_of_birth = excluded.date_of_birth,
      birth_place = excluded.birth_place, verified_by = excluded.verified_by, fetched_at = excluded.fetched_at, updated_at = now()
    returning 1
  ), del as (
    delete from public.player_official_bio t
     where t.source = 'laliga.com' and not exists (select 1 from pick p where p.name_slug = t.name_slug)
    returning 1
  )
  select jsonb_build_object(
           'published', (select count(*) from up), 'retired', (select count(*) from del),
           'by_id', (select count(*) from pick where verified_by = 'laliga-id'),
           'by_name_dob', (select count(*) from pick where verified_by = 'laliga-name-dob-espn'),
           'by_name_country_era', (select count(*) from pick where verified_by = 'laliga-name-country-era'),
           'conflicting_slugs', (select count(*) from n where n_people > 1))
    into v_out;
  -- Club pages fill only what LALIGA leaves empty, so they are decided after it.
  v_out := v_out || jsonb_build_object('club', public.refresh_club_official_bio());
  return v_out;
end
$$;
-- anon-exec: unchanged (refresh_laliga_official_bio) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.
