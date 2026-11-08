-- audit_20261108_espn_search_pro_league_team
--
-- Two more ways an ambiguous ESPN search resolves for Top Shot / All Day / Candy, both narrowing to
-- the person the MOMENT is of, before the existing DOB / era test (which still applies to the pick):
--   espn-search-pro-unique   exactly one exact-name hit is in a PRO league (nba / wnba / nfl / mlb) —
--                            a moment is a pro game, so college namesakes are not candidates. Fixes
--                            Cameron Boozer, Caleb Wilson, Dailyn Swain (one NBA record + college
--                            records with no DOB, measured 2026-11-08).
--   espn-search-team-agrees  several pro hits, and exactly one is on the card's team in ESPN's box
--                            scores (espn_athletes.team_abbr). The team-name -> abbreviation map is
--                            DERIVED from players already linked by league identity (>= 3 players,
--                            >= 60 % of that name's pairs), not hand-kept. For Max Muncy (Dodgers card;
--                            ESPN has the Dodgers' b. 1990 and the A's b. 2002) and Julio Rodríguez.
-- Base: live prosrc md5 12fd4fada2827edc413df44e5bf4ba1b (= 20261108221608 body), re-read 2026-11-08.
--
-- Revert: re-apply the 20261108221608 body of refresh_espn_search_crosswalk, delete the rows with the
-- two new matched_by values, restore the CHECK without them, then select public.refresh_espn_search_crosswalk();

alter table public.espn_search_crosswalk drop constraint espn_search_crosswalk_matched_by_check;
alter table public.espn_search_crosswalk add constraint espn_search_crosswalk_matched_by_check
  check (matched_by in ('espn-search-unique', 'espn-search-same-person', 'espn-search-pro-unique', 'espn-search-team-agrees',
                        'ambiguous', 'too_common', 'no_match', 'era_mismatch', 'pending_bio', 'unverifiable'));

create or replace function public.refresh_espn_search_crosswalk()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_out jsonb;
begin
  -- A box-score crosswalk verdict on a Panini key supersedes the search (874 of 874 links agreed
  -- when both existed, 2026-11-08; the search had resolved 7 keys the box scores call ambiguous).
  delete from public.espn_search_crosswalk c
   where c.collection_slug = 'panini_blockchain'
     and exists (select 1 from public.panini_espn_crosswalk x where x.name_slug = c.name_slug and x.sport = c.sport);

  with s as (
    select q.collection_slug, q.name_slug, q.sport, q.player_label, q.total_found, q.exact,
           (select count(distinct x->>'espn_id') from jsonb_array_elements(q.exact) x) as n
      from public.espn_search_queue q
     where q.status = 'done' and q.collection_slug in ('ufc_strike', 'panini_blockchain', 'nba_top_shot', 'nfl_all_day', 'candy_mlb')
       and not (q.collection_slug = 'panini_blockchain'
                and exists (select 1 from public.panini_espn_crosswalk x where x.name_slug = q.name_slug and x.sport = q.sport))
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
  ), tm0 as (
    -- Team name -> ESPN team abbreviation, DERIVED from players already linked by league identity
    -- (their editions' team vs the team ESPN's box scores show them on); no hand-kept table.
    select e.team_name, a.league, a.team_abbr, count(distinct pi.player_id) as n
      from public.player_identities pi
      join public.espn_athletes a on a.espn_id = pi.espn_id and a.team_abbr is not null
      join public.editions e on e.player_id = pi.player_id and e.team_name is not null
     where pi.espn_id is not null and a.league in ('nba', 'wnba', 'nfl', 'mlb')
     group by 1, 2, 3
  ), tm as (
    -- A traded player puts noise in the pairs: keep a name's abbreviation only when it holds >= 60 %
    -- of that name's linked players (and at least 3).
    select distinct on (t.team_name, t.league) t.team_name, t.league, t.team_abbr
      from tm0 t
     where t.n >= 3
       and t.n * 10 >= 6 * (select sum(t2.n) from tm0 t2 where t2.team_name = t.team_name and t2.league = t.league)
     order by t.team_name, t.league, t.n desc
  ), teams as (
    select c.slug as collection_slug, public.rpc_name_slug(p.name) as name_slug, array_agg(distinct e.team_name) as team_names
      from public.players p
      join public.collections c on c.id = p.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day', 'candy_mlb')
      join public.editions e on e.player_id = p.id and e.team_name is not null
     group by 1, 2
  ), pro as (
    -- A Top Shot / All Day / Candy moment is a PRO game, so a college namesake is not a candidate.
    -- Measured 2026-11-08: Cameron Boozer, Caleb Wilson, Dailyn Swain each had one NBA record plus
    -- college records (ESPN keeps them apart, the college ones with no DOB) and sat 'ambiguous';
    -- Max Muncy / Julio Rodríguez have several MLB namesakes and only the card's team tells them apart.
    select s.collection_slug, s.name_slug, s.sport,
           count(distinct x->>'espn_id') as n_pro,
           min(x->>'espn_id') as only_pro,
           count(distinct x->>'espn_id') filter (where a.team_abbr is not null) as n_team,
           min(x->>'espn_id') filter (where a.team_abbr is not null) as team_pick
      from s
     cross join lateral jsonb_array_elements(s.exact) x
      left join teams on teams.collection_slug = s.collection_slug and teams.name_slug = s.name_slug
      left join public.espn_athletes a
             on a.espn_id = x->>'espn_id' and a.league = x->>'league'
            and a.team_abbr in (select tm.team_abbr from tm where tm.league = a.league and tm.team_name = any (teams.team_names))
     where s.n > 1 and s.total_found <= 25
       and s.collection_slug in ('nba_top_shot', 'nfl_all_day', 'candy_mlb')
       and x->>'league' in ('nba', 'wnba', 'nfl', 'mlb')
     group by 1, 2, 3
  ), v as (
    select s.*,
           case when s.n = 1 and s.total_found <= 25 then s.exact->0
                when d.pick is not null and d.n_dob_known = s.n and d.n_dob = 1
                  then (select x from jsonb_array_elements(s.exact) x where x->>'espn_id' = d.pick limit 1)
                when pro.n_pro = 1
                  then (select x from jsonb_array_elements(s.exact) x where x->>'espn_id' = pro.only_pro limit 1)
                when pro.n_pro > 1 and pro.n_team = 1
                  then (select x from jsonb_array_elements(s.exact) x where x->>'espn_id' = pro.team_pick limit 1) end as hit,
           case when s.n = 1 and s.total_found <= 25 then 'espn-search-unique'
                when d.pick is not null and d.n_dob_known = s.n and d.n_dob = 1 then 'espn-search-same-person'
                when pro.n_pro = 1 then 'espn-search-pro-unique'
                when pro.n_pro > 1 and pro.n_team = 1 then 'espn-search-team-agrees'
                when s.n > 1 then 'ambiguous'
                when s.n = 1 then 'too_common'
                else 'no_match' end as status
      from s
      left join d on d.collection_slug = s.collection_slug and d.name_slug = s.name_slug and d.sport = s.sport
      left join pro on pro.collection_slug = s.collection_slug and pro.name_slug = s.name_slug and pro.sport = s.sport
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
           -- No dated moments (UFC, Panini): the hit still needs a stated DOB — "Jerry Rice" and
           -- "Mike McDaniel" matched college-football records with none (2026-11-08).
           case when v.hit is null then v.status
                when b.status = 'no_dob' then 'unverifiable'
                when era.first_d is null and b.status = 'ok' and b.date_of_birth is not null then v.status
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
           'pro_unique', count(*) filter (where matched_by = 'espn-search-pro-unique'),
           'team_agrees', count(*) filter (where matched_by = 'espn-search-team-agrees'),
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

select public.refresh_espn_search_crosswalk();
