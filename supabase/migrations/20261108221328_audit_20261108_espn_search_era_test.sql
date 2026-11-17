-- audit_20261108_espn_search_era_test
--
-- The ESPN search crosswalk now applies the DOB era test wherever the moments are dated — Top
-- Shot, All Day, Candy (UFC and Panini editions carry no game date). Measured 2026-11-08, minutes
-- after 20261108221124 extended the search to those collections: three All Day legends had linked to
-- a namesake ESPN record — "Kellen Winslow" (moments 1982–83) → Kellen Winslow b. 1983 (the son),
-- "Gerald Riggs" (1985) → b. 1983, "Ken Anderson" (1982) → b. 1975. A unique name in ESPN's search
-- is not the person when ESPN has no record of the legend at all.
--
-- refresh_espn_search_crosswalk: for a key with dated moments, the hit links only if its DOB puts
-- the athlete at 15–41 at the first moment and ≤ 43 at the last; otherwise 'era_mismatch'; a hit
-- with no DOB yet is 'pending_bio' (espn_bio_targets now fetches every hit of a person-collection
-- search), and ESPN stating no DOB is 'unverifiable'. None of these link.
--
-- Revert: re-apply the 20261108221124 bodies of refresh_espn_search_crosswalk and espn_bio_targets,
-- restore the matched_by CHECK without era_mismatch / pending_bio / unverifiable (delete those rows
-- first), then select public.refresh_espn_search_crosswalk();

alter table public.espn_search_crosswalk drop constraint espn_search_crosswalk_matched_by_check;
alter table public.espn_search_crosswalk add constraint espn_search_crosswalk_matched_by_check
  check (matched_by in ('espn-search-unique', 'espn-search-same-person', 'ambiguous', 'too_common', 'no_match',
                        'era_mismatch', 'pending_bio', 'unverifiable'));

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
     where q.status = 'done' and q.collection_slug in ('ufc_strike', 'panini_blockchain', 'nba_top_shot', 'nfl_all_day', 'candy_mlb')
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
  ), era as (
    -- The moments themselves date the person: Top Shot / All Day / Candy editions carry game dates.
    select c.slug as collection_slug, public.rpc_name_slug(p.name) as name_slug,
           min(e.game_date)::date as first_d, max(e.game_date)::date as last_d
      from public.players p
      join public.collections c on c.id = p.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day', 'candy_mlb')
      join public.editions e on e.player_id = p.id
     where e.game_date is not null
     group by 1, 2
  ), w as (
    -- DOB era test (same bounds as Golazos: 15–41 at the first moment, ≤ 43 at the last). Measured
    -- 2026-11-08 before this test: All Day "Kellen Winslow" (1982 moments) had linked to ESPN's
    -- Kellen Winslow b. 1983 — the son; "Gerald Riggs" and "Ken Anderson" the same shape.
    select v.*,
           case when v.hit is null or era.first_d is null then v.status
                when b.status = 'no_dob' then 'unverifiable'
                when b.status is distinct from 'ok' or b.date_of_birth is null then 'pending_bio'
                when extract(year from age(era.first_d, b.date_of_birth)) between 15 and 41
                 and extract(year from age(era.last_d, b.date_of_birth)) <= 43 then v.status
                else 'era_mismatch' end as final_status
      from v
      left join era on era.collection_slug = v.collection_slug and era.name_slug = v.name_slug
      left join public.espn_athlete_bio b on b.sport = v.sport and b.espn_id = v.hit->>'espn_id'
  )
  insert into public.espn_search_crosswalk as c
    (collection_slug, name_slug, sport, player_label, espn_id, display_name, league_slug, matched_by, candidates, matched_at)
  select collection_slug, name_slug, sport, player_label,
         case when final_status like 'espn-search-%' then hit->>'espn_id' end,
         case when final_status like 'espn-search-%' then hit->>'name' end,
         case when final_status like 'espn-search-%' then hit->>'league' end,
         final_status,
         case when final_status = 'espn-search-unique' then null else exact || jsonb_build_object('total_found', total_found) end,
         now()
    from w
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
           'era_mismatch', count(*) filter (where matched_by = 'era_mismatch'),
           'pending_bio', count(*) filter (where matched_by = 'pending_bio'),
           'unverifiable', count(*) filter (where matched_by = 'unverifiable'),
           'by_collection_sport', (select jsonb_object_agg(k, n) from (
               select collection_slug || ':' || sport as k, count(*) filter (where espn_id is not null) as n
                 from public.espn_search_crosswalk group by 1) t))
    into v_out from public.espn_search_crosswalk;
  return v_out;
end
$$;
-- anon-exec: unchanged (refresh_espn_search_crosswalk) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

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
     where q.status = 'done' and q.total_found <= 25
       and (   (jsonb_array_length(q.exact) > 1 and q.collection_slug in ('ufc_strike', 'panini_blockchain'))
            or q.collection_slug in ('nba_top_shot', 'nfl_all_day', 'candy_mlb'))  -- era test needs every hit's DOB
  )
  select distinct on (t.sport, t.espn_id) t.sport, t.league_seg, t.espn_id
    from t
   order by t.sport, t.espn_id, t.league_seg nulls last
$$;
-- anon-exec: unchanged (espn_bio_targets) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

select public.refresh_espn_search_crosswalk();