-- audit_20261108_official_bio_fill_birthplace
--
-- A club page may fill the birthplace LALIGA leaves empty when both state the SAME date of birth
-- (measured 2026-11-08: exactly one case — Zidane, LALIGA b. 1972-06-23 with no place; realmadrid.com
-- b. 1972-06-23, Marseille). refresh_club_official_bio allows the club row in that case only, and
-- get_player_bio, given several official rows for ONE name slug that agree on the DOB, returns the
-- one carrying a birthplace (LALIGA first otherwise). Official rows that disagree still publish nothing.
-- Base: live prosrc md5 a7bbc73b (get_player_bio = 20261108224157) and 804aa1c1
-- (refresh_club_official_bio = 20261108234026), re-read 2026-11-08.
--
-- Revert: re-apply those two bodies, then select public.refresh_laliga_official_bio();

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
    union
    select s.sport, s.espn_id
      from public.espn_search_crosswalk s
     where s.collection_slug = p_collection_slug and s.espn_id is not null and s.name_slug = any (p_slugs)
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
  ), official as (
    -- One name slug behind the request, and every official row for it states the SAME date of birth
    -- (or none): then the row with a birthplace is shown (LALIGA has Zidane's DOB but no place; Real
    -- Madrid's page has both). Official rows that disagree publish nothing.
    select o.*
      from public.player_official_bio o
     where o.collection_slug = p_collection_slug and o.name_slug = any (p_slugs)
       and (select count(distinct o2.name_slug) from public.player_official_bio o2
             where o2.collection_slug = p_collection_slug and o2.name_slug = any (p_slugs)) = 1
       and (select count(distinct o2.date_of_birth) from public.player_official_bio o2
             where o2.collection_slug = p_collection_slug and o2.name_slug = any (p_slugs)) <= 1
     order by (o.birth_place is null), (o.source <> 'laliga.com'), o.source
     limit 1
  )
  select jsonb_build_object(
    'linked', (select count(*) from ids),
    'espn', (select jsonb_build_object('espn_id', espn_id, 'date_of_birth', date_of_birth, 'birth_city', birth_city,
                                       'birth_state', birth_state, 'birth_country', birth_country, 'citizenship', citizenship,
                                       'college', college_name, 'college_id', college_id, 'fetched_at', fetched_at)
               from one),
    'onchain', (select jsonb_build_object('date_of_birth', dob, 'birthplace', place) from onchain),
    'nflverse_date_of_birth', (select birth_date from nflverse),
    'official', (select jsonb_build_object('source', source, 'url', source_url, 'date_of_birth', date_of_birth,
                                           'birth_place', birth_place, 'verified_by', verified_by, 'fetched_at', fetched_at)
                   from official))
$$;
-- anon-exec: unchanged (get_player_bio) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

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
     -- Fill only what LALIGA leaves empty: no LALIGA row, or one with no birthplace and the SAME DOB.
     where not exists (select 1 from public.player_official_bio t
                        where t.collection_slug = 'laliga_golazos' and t.name_slug = o.name_slug
                          and t.source not in ('realmadrid.com', 'fcbarcelona.com')
                          and (t.birth_place is not null or t.date_of_birth is distinct from o.date_of_birth))
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
-- anon-exec: unchanged (refresh_club_official_bio) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

select public.refresh_laliga_official_bio();
