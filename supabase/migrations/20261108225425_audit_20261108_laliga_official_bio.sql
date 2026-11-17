-- audit_20261108_laliga_official_bio
--
-- LaLiga Golazos players' place and date of birth from LALIGA's own player pages (laliga.com), the
-- league's official site (2026-11-08). ESPN's soccer records carry citizenship but no birthplace
-- (sports.core and common/v3 both empty), and Golazos chain metadata carries PlayerCountry
-- (nationality) only. No crowdsourced source is used.
--
-- How the pages were found: Golazos play metadata on Flow carries PlayerDataID (LALIGA / Opta's player
-- id). Candidate slugs come from laliga.com's own sitemap-players.xml (1,935 current players) plus
-- name-derived guesses for players who have left. Each page's __NEXT_DATA__ player object
-- (date_of_birth, place_of_birth, country) and its squad-photo asset paths
-- (assets.laliga.com/squad/<yr>/t<team>/p<OptaID>/) were read once, politely, from the sandbox
-- (robots.txt allows /en-ES/; scripts/bio/laliga-player-pages.py). LALIGA's own API was NOT used: its
-- key is embedded in the site, and pulling it out is not ours to do.
--
-- Identity, per Golazos PlayerDataID (laliga_player_candidates.verified_by):
--   laliga-id            the page's squad photo path carries the SAME Opta id as the chain — exact.
--   laliga-name-dob-espn no photo id on the page: name matches the chain's name (known / jersey /
--                        first+last), the page's country does not contradict the chain's, AND its
--                        date of birth equals the linked ESPN record's. One such candidate only
--                        (LALIGA's duplicate pages for one person — same name, same DOB — count once).
-- A name slug published only when every PlayerDataID behind it resolves to the same LALIGA person.
-- LALIGA gives a city only ("Montevideo"); `country` on its page is nationality, never written as a
-- birth country.
--
-- Revert: drop function public.refresh_laliga_official_bio(); drop table public.laliga_player_candidates;
--   drop table public.golazos_play_player;
--   delete from public.player_official_bio where source = 'laliga.com';

create table if not exists public.golazos_play_player (
  play_id         int primary key,
  player_data_id  text not null,
  player_country  text,
  read_at         timestamptz not null default now()
);
alter table public.golazos_play_player enable row level security;
revoke all on public.golazos_play_player from anon, authenticated;
comment on table public.golazos_play_player is
  'Golazos on-chain play id -> PlayerDataID (LALIGA/Opta player id) + PlayerCountry, read from Golazos.getPlayData on Flow mainnet 2026-11-08. 20261108.';

create table if not exists public.laliga_player_candidates (
  player_data_id  text not null,
  play_ids        int[] not null,
  laliga_slug     text not null,
  laliga_id       int,
  laliga_name     text,
  date_of_birth   date,
  birth_place     text,
  verified_by     text not null check (verified_by in ('laliga-id', 'laliga-name-dob-espn')),
  fetched_at      timestamptz not null default now(),
  primary key (player_data_id, laliga_slug)
);
alter table public.laliga_player_candidates enable row level security;
revoke all on public.laliga_player_candidates from anon, authenticated;
comment on table public.laliga_player_candidates is
  'laliga.com player pages that may be a Golazos PlayerDataID (verified_by says how). refresh_laliga_official_bio() decides. 20261108.';

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
        or (c.verified_by = 'laliga-name-dob-espn' and c.date_of_birth is not null and c.date_of_birth = espn.date_of_birth
            and not exists (select 1 from public.laliga_player_candidates i
                             where i.player_data_id = c.player_data_id and i.verified_by = 'laliga-id'))
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
           'conflicting_slugs', (select count(*) from n where n_people > 1))
    into v_out;
  return v_out;
end
$$;
revoke all on function public.refresh_laliga_official_bio() from public, anon, authenticated;
-- anon-exec: revoked (refresh_laliga_official_bio) — new fn; REVOKE FROM PUBLIC, anon, authenticated; owner-only; verified anon=false via has_function_privilege 2026-11-08.
