-- audit_20261108_player_bio_official_source
--
-- get_player_bio gains an `official` field: the league's own athlete page (UFC.com, LALIGA) from
-- player_official_bio (20261108224008), used only when exactly ONE verified row sits behind the
-- requested name slugs. ESPN's soccer and MMA records carry no birthplace, so for Golazos and UFC
-- Strike this is the only birthplace source; the page shows it with the source named.
-- Base: live prosrc md5 b41aacf179d32ca3f4ddde0e94aa393b (= 20261108213822 body), re-read 2026-11-08.
--
-- Revert: re-apply the 20261108213822 body of get_player_bio.

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
    select o.*
      from public.player_official_bio o
     where o.collection_slug = p_collection_slug and o.name_slug = any (p_slugs)
       and (select count(*) from public.player_official_bio o2
             where o2.collection_slug = p_collection_slug and o2.name_slug = any (p_slugs)) = 1
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
