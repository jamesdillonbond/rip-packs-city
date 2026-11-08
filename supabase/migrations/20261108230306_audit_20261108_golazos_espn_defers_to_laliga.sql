-- audit_20261108_golazos_espn_defers_to_laliga
--
-- refresh_golazos_espn_crosswalk: where LALIGA's own player page states the person's date of birth —
-- identified WITHOUT ESPN, by the Opta id on the page or by strict name + nationality + era
-- (laliga_player_candidates, 20261108225425 / 225935) — an ESPN candidate whose DOB differs fails.
-- Measured 2026-11-08, five ESPN links contradicted LALIGA, two of them on nationality as well:
-- Pepe (chain Portugal) -> ESPN 256909 Brazilian b. 1997 (LALIGA: Képler "Pepe" b. 1983); Claudio
-- Bravo (chain Chile) -> 235873 Argentine b. 1997 (LALIGA: the goalkeeper b. 1983); Rodri (Betis, b.
-- 2000) -> 231828 b. 1996; Jordi Masip (b. 1989) -> 150792 b. 2000; Javi Sánchez (b. 1997-03-14) ->
-- 191899 b. 1997-06-02. Each namesake had passed the age-at-match era test. After the crosswalk,
-- refresh_laliga_official_bio() runs so the two stay consistent (its name+DOB rule reads this table).
-- Base: live prosrc md5 df885237af83da83f20c9ff0e1762130 (= 20261108214928 body), re-read 2026-11-08.
--
-- Revert: re-apply the 20261108214928 body of refresh_golazos_espn_crosswalk, then
--   select public.refresh_golazos_espn_crosswalk(); select public.refresh_laliga_official_bio();

create or replace function public.refresh_golazos_espn_crosswalk()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_out jsonb;
begin
  with era as (
    select public.rpc_name_slug(e.player_name) as name_slug,
           min(e.game_date)::date as first_d, max(e.game_date)::date as last_d
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.slug = 'laliga_golazos'
     where e.game_date is not null
     group by 1
  ), laliga as (
    -- LALIGA's own player page states this person's DOB, identified WITHOUT ESPN: by the Opta id on the
    -- page (laliga-id) or by strict name + nationality + era (laliga-name-country-era, used only when
    -- no laliga-id page exists). One DOB per name slug, or no anchor.
    select k.name_slug, min(c.date_of_birth) as dob
      from (select distinct g.player_data_id, public.rpc_name_slug(e.player_name) as name_slug
              from public.golazos_play_player g
              join public.editions e on e.play_id_onchain = g.play_id
              join public.collections col on col.id = e.collection_id and col.slug = 'laliga_golazos') k
      join public.laliga_player_candidates c on c.player_data_id = k.player_data_id and c.date_of_birth is not null
       and (c.verified_by = 'laliga-id'
            or (c.verified_by = 'laliga-name-country-era'
                and not exists (select 1 from public.laliga_player_candidates i
                                 where i.player_data_id = c.player_data_id and i.verified_by = 'laliga-id')))
     group by k.name_slug
    having count(distinct c.date_of_birth) = 1
  ), cand as (
    select c.name_slug, c.player_label, c.espn_id, c.espn_display_name, c.how, b.date_of_birth,
           case when b.status <> 'ok' or b.date_of_birth is null or era.first_d is null then null
                -- An ESPN namesake whose DOB contradicts LALIGA's is not this person, era or no era.
                -- Measured 2026-11-08: Pepe (chain Portugal) -> ESPN's Brazilian b. 1997; Claudio Bravo
                -- (chain Chile) -> an Argentine b. 1997; Rodri (Betis, b. 2000) -> Rodri b. 1996; Jordi
                -- Masip (b. 1989) -> b. 2000; Javi Sánchez (b. 1997-03-14) -> b. 1997-06-02.
                when laliga.dob is not null and b.date_of_birth <> laliga.dob then false
                else extract(year from age(era.first_d, b.date_of_birth)) between 15 and 41
                 and extract(year from age(era.last_d, b.date_of_birth)) <= 43 end as era_ok,
           -- an unknown that will never become known: ESPN states no DOB, the lookup failed 3 times,
           -- or the key has no dated Golazos moment to test against
           (b.status = 'no_dob' or (b.status = 'error' and b.attempts >= 3) or era.first_d is null) as final_unknown,
           exists (select 1 from public.espn_athletes a where a.espn_id = c.espn_id) as in_box
      from public.golazos_espn_candidates() c
      left join public.espn_athlete_bio b on b.sport = 'soccer' and b.espn_id = c.espn_id
      left join era on era.name_slug = c.name_slug
      left join laliga on laliga.name_slug = c.name_slug
  ), m as (
    select name_slug, max(player_label) as player_label,
           count(*) filter (where era_ok) as n_pass,
           count(*) filter (where era_ok is null and not coalesce(final_unknown, false)) as n_unknown,
           count(*) filter (where era_ok is null and coalesce(final_unknown, false)) as n_final_unknown,
           count(distinct date_of_birth) filter (where era_ok) as n_pass_dob,
           -- several ESPN records with ONE name and ONE date of birth are one person (duplicate
           -- records, e.g. Iker Casillas 11811 / 19295): prefer the record the box scores use
           coalesce(min(espn_id) filter (where era_ok and in_box), min(espn_id) filter (where era_ok)) as espn_id,
           coalesce(min(espn_display_name) filter (where era_ok and in_box), min(espn_display_name) filter (where era_ok)) as espn_display_name,
           min(how) filter (where era_ok) as how,
           jsonb_agg(jsonb_build_object('espn_id', espn_id, 'name', espn_display_name, 'how', how,
                                        'dob', date_of_birth, 'era_ok', era_ok) order by espn_id) as candidates
      from cand
     group by name_slug
  ), s as (
    select m.*,
           case when n_unknown > 0 then 'pending_bio'
                when n_pass >= 1 and n_pass_dob = 1 and n_final_unknown = 0 then how || '-name+dob-era'
                when n_pass > 1 then 'ambiguous'
                when n_final_unknown > 0 then 'unverifiable'
                else 'era_mismatch' end as status
      from m
  ), d as (
    delete from public.golazos_espn_crosswalk c where not exists (select 1 from s where s.name_slug = c.name_slug)
    returning 1
  )
  insert into public.golazos_espn_crosswalk as c (name_slug, player_label, espn_id, espn_display_name, matched_by, candidates, matched_at)
  select name_slug, player_label,
         case when status like '%-name+dob-era' then espn_id end,
         case when status like '%-name+dob-era' then espn_display_name end,
         status, candidates, now()
    from s
  on conflict (name_slug) do update set
    player_label = excluded.player_label, espn_id = excluded.espn_id, espn_display_name = excluded.espn_display_name,
    matched_by = excluded.matched_by, candidates = excluded.candidates,
    matched_at = case when (c.espn_id, c.matched_by) is distinct from (excluded.espn_id, excluded.matched_by)
                      then now() else c.matched_at end;

  select jsonb_build_object(
           'matched', count(*) filter (where espn_id is not null),
           'fuzzy', count(*) filter (where matched_by = 'fuzzy-name+dob-era'),
           'ambiguous', count(*) filter (where matched_by = 'ambiguous'),
           'era_mismatch', count(*) filter (where matched_by = 'era_mismatch'),
           'pending_bio', count(*) filter (where matched_by = 'pending_bio'),
           'unverifiable', count(*) filter (where matched_by = 'unverifiable'))
    into v_out from public.golazos_espn_crosswalk;
  -- LALIGA verdicts read this crosswalk (name + ESPN DOB; strict rule only where ESPN states none).
  v_out := v_out || jsonb_build_object('laliga', public.refresh_laliga_official_bio());
  return v_out;
end
$$;
-- anon-exec: unchanged (refresh_golazos_espn_crosswalk) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

select public.refresh_golazos_espn_crosswalk();
