-- audit_20261108_laliga_refresh_scoped_to_golazos
--
-- refresh_laliga_official_bio deleted EVERY laliga.com row it had not just picked — with no collection
-- filter. Panini soccer players now also carry laliga.com rows (2026-11-08: a LALIGA page whose name
-- AND date of birth both equal the linked ESPN record's, for its birthplace — ESPN's soccer records
-- carry none), so the delete is scoped to laliga_golazos. Found before loading those rows, not after.
-- Base: live prosrc md5 c4ad6f16d20c0963c629362400b79c58 (= 20261108234026 body), re-read 2026-11-08.
--
-- Revert: re-apply the 20261108234026 body of refresh_laliga_official_bio (first delete the Panini
--   laliga.com rows, or they are wiped on its next run).

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
    -- Golazos rows only: Panini soccer players also carry laliga.com rows (name + ESPN DOB, loaded
    -- separately) and this function never decides those.
    delete from public.player_official_bio t
     where t.source = 'laliga.com' and t.collection_slug = 'laliga_golazos'
       and not exists (select 1 from pick p where p.name_slug = t.name_slug)
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
