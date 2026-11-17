-- audit_20261108_laliga_strict_name_era
--
-- A third LALIGA identity rule for Golazos legends whose ESPN record states no date of birth (Xavi,
-- Sergio Ramos, Zidane, Valerón … measured 2026-11-08: the name+ESPN-DOB rule could not fire for them):
--   laliga-name-country-era  the chain's nickname or given name matches AND a real surname token
--     matches (particles de/da/dos/del… ignored), the page's country EQUALS the chain's PlayerCountry
--     (an absent country does not count), every PlayerDataID candidate passing this resolves to ONE
--     person, and the page's DOB puts the player at 20–41 on the first match date (on-chain MatchDate)
--     and ≤ 43 on the last. 20, not 15: this rule has no second source and its failure mode is a
--     YOUNGER namesake — Golazos Lucas Pérez (b. 1988) vs LALIGA's Lucas Pérez Calvo (b. 2003) was 19
--     on a 2022 match date and is excluded. Nicknames alone never match: "Kaká" (Ricardo Izecson Dos
--     Santos Leite) vs LALIGA's Kaká (Claudiano Bezerra Da Silva) shares no surname token.
--   Never published against a DISAGREEING ESPN DOB — only where ESPN states none.
-- Base: the 20261108225425 body of refresh_laliga_official_bio (applied minutes earlier).
--
-- Revert: re-apply the 20261108225425 body, restore the CHECK without 'laliga-name-country-era'
-- (delete those candidate rows first), then select public.refresh_laliga_official_bio();

alter table public.laliga_player_candidates drop constraint laliga_player_candidates_verified_by_check;
alter table public.laliga_player_candidates add constraint laliga_player_candidates_verified_by_check
  check (verified_by in ('laliga-id', 'laliga-name-dob-espn', 'laliga-name-country-era'));

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
    -- One LALIGA person per name slug: same normalised name + same DOB across every row behind it.
    -- And every PlayerDataID behind the slug must have resolved: a slug like "ronaldo" or "pedro"
    -- that covers two players is never answered for one of them.
    select o.name_slug, count(distinct (public.rpc_name_slug(o.laliga_name), o.date_of_birth)) as n_people
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
  return v_out;
end
$$;
-- anon-exec: unchanged (refresh_laliga_official_bio) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.
