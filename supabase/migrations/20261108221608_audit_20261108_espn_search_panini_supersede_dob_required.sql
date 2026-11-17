-- audit_20261108_espn_search_panini_supersede_dob_required
--
-- Three tightenings of the ESPN search crosswalk after a review of every Panini football /
-- basketball search link (2026-11-08):
--
-- 1. A Panini key the box-score crosswalk (panini_espn_crosswalk) has ANY verdict on is no longer
--    searched or linked by search. Where both had linked, they agreed 874 of 874 times; but search
--    had "resolved" 7 keys the box-score crosswalk calls ambiguous / family_ambiguous by picking one
--    namesake — Mark Ingram (ESPN b. 1965, Sr) for a Panini Mark Ingram II card, Gerald Riggs (b. 1983,
--    Jr), Jerry Rice (a college-football record), Gary Payton, Tim Hardaway, RG3, Byron Murphy II.
-- 2. With no dated moments to test an era (UFC, Panini), a search hit links only when ESPN states
--    its DOB; ESPN stating none is 'unverifiable', not-yet-fetched is 'pending_bio'.
-- 3. espn_bio_targets fetches every hit of every fully-seen search (the DOB requirement needs them).
--
-- Revert: re-apply the 20261108221124 body of espn_search_population and the 20261108221328 bodies
-- of refresh_espn_search_crosswalk and espn_bio_targets, then select public.refresh_espn_search_crosswalk();

create or replace function public.espn_search_population()
returns table (collection_slug text, name_slug text, sport text, player_label text)
language sql stable
set search_path = pg_catalog, public
as $$
  with ufc as (
    select 'ufc_strike'::text as collection_slug, public.rpc_name_slug(p.name) as name_slug, 'mma'::text as sport, max(p.name::text) as player_label
      from public.players p
      join public.collections c on c.id = p.collection_id and c.slug = 'ufc_strike'
     where public.rpc_name_slug(p.name) is not null
     group by 2
  ), ps as (
    select public.rpc_name_slug(e.player_name) as slug,
           case when pp.last_grid_sport ilike '%basketball%' then 'basketball' else lower(pp.last_grid_sport) end as sport
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.slug = 'panini_blockchain'
      join public.panini_products pp on pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
     where e.external_id like 'packcard-%' and pp.last_grid_sport is not null
     group by 1, 2
  ), panini as (
    select 'panini_blockchain'::text, m.group_key, ps.sport, max(m.group_label)
      from public.market_cap_current m
      join ps on ps.slug = m.group_key
     where m.collection_slug = 'panini_blockchain' and m.grain = 'player' and m.is_primary
       -- any box-score crosswalk verdict wins, a link AND an 'ambiguous' / 'family_ambiguous'
       -- (search must not resolve Mark Ingram Sr / II or Gerald Riggs / Jr by picking one)
       and not exists (select 1 from public.panini_espn_crosswalk x
                        where x.name_slug = m.group_key and x.sport = ps.sport)
     group by m.group_key, ps.sport
  ), golazos as (
    select 'laliga_golazos'::text, m.group_key, 'soccer'::text, max(m.group_label)
      from public.market_cap_current m
     where m.collection_slug = 'laliga_golazos' and m.grain = 'player' and m.is_primary
       and not exists (select 1 from public.golazos_espn_crosswalk x
                        where x.name_slug = m.group_key and x.candidates::text ~ '"how": "(exact|fuzzy)"')
     group by m.group_key
  ), person as (
    -- Top Shot / All Day / Candy players with no ESPN id on their league identity: legends,
    -- WNBA and draft prospects ESPN's search knows. Team subjects (All Day "Dallas Cowboys") find no
    -- same-name player and land as no_match.
    select c.slug::text, public.rpc_name_slug(p.name),
           case c.slug when 'nba_top_shot' then 'basketball' when 'nfl_all_day' then 'football' else 'baseball' end,
           max(p.name::text)
      from public.players p
      join public.collections c on c.id = p.collection_id and c.slug in ('nba_top_shot', 'nfl_all_day', 'candy_mlb')
     where public.rpc_name_slug(p.name) is not null and p.name !~ '[<>]'
       and not exists (select 1 from public.player_identities pi where pi.player_id = p.id and pi.espn_id is not null)
     group by c.slug, public.rpc_name_slug(p.name)
  )
  select * from ufc union all select * from panini union all select * from golazos union all select * from person
$$;
-- anon-exec: unchanged (espn_search_population) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

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
     where q.status = 'done' and q.total_found <= 25  -- every hit's DOB: the era test and the DOB requirement need it
  )
  select distinct on (t.sport, t.espn_id) t.sport, t.league_seg, t.espn_id
    from t
   order by t.sport, t.espn_id, t.league_seg nulls last
$$;
-- anon-exec: unchanged (espn_bio_targets) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

select public.refresh_espn_search_crosswalk();