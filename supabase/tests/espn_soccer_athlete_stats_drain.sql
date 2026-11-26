-- DB invariant: the Panini soccer card-back lane (2026-11-26, Trevor: "Yes do it all").
--
-- A soccer card's back shows the player's line in the competition and season its PRODUCT is from.
-- Rules pinned here:
--   (a) panini_soccer_competition maps only products that name ONE competition (LaLiga → esp.1,
--       Serie A → ita.1, Ligue 1 / Foot FR → fra.1, the men's World Cup → fifa.world), the season by
--       ESPN's numbering (a club season by the year it starts); qualifiers, "Saga", women's and
--       competition-less products map to nothing;
--   (b) dispatch asks the discovery request first, then one request per (team of his career ×
--       competition his cards need) — never a competition no card needs;
--   (c) drain stores an answer only when ESPN's own filters say it is the team AND competition asked
--       for (ESPN answers an unknown pair with the athlete's default: 'mismatch', nothing stored);
--       404 is 'none'; a failed request is 'error'; keepers' CS/SV/GA lines are kind 'keeper';
--       a re-fetch retires lines the new answer no longer carries;
--   (d) the reader is NULL for an ambiguous player or a product with no competition, and returns the
--       product's competition-season lines with the team's display name.
--
-- The function DDL below is VERBATIM from
-- supabase/migrations/20261126184303_audit_20261126_panini_soccer_season_lines.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text, timed_out boolean);
CREATE TABLE net._test_requests (id bigserial PRIMARY KEY, url text);
CREATE FUNCTION net.http_get(url text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net._test_requests (url) VALUES (url) RETURNING id
$$;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text, player_name text);
CREATE TABLE public.panini_products (set_id bigint PRIMARY KEY, name text, last_grid_sport text);
CREATE TABLE public.panini_espn_crosswalk (name_slug text, sport text, player_label text, espn_id text);
CREATE TABLE public.pipeline_runs_test (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started timestamptz, p_in int, p_written int, p_skipped int,
  p_ok boolean, p_error text, a text, b text, c text, p_extra jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.pipeline_runs_test VALUES (p_pipeline, p_ok, p_extra)
$$;

CREATE TABLE public.espn_soccer_athlete_fetches (
  espn_id text not null, league_slug text not null, team_id text not null,
  status text not null check (status in ('requested', 'ok', 'none', 'mismatch', 'error')),
  request_id bigint, requested_at timestamptz, fetched_at timestamptz, attempts int not null default 0,
  team_ids text[], teams jsonb, lines int, last_error text, primary key (espn_id, league_slug, team_id)
);
CREATE TABLE public.espn_soccer_athlete_lines (
  espn_id text not null, league_slug text not null, team_id text not null, team_slug text, season_year int not null,
  split_name text not null, kind text not null check (kind in ('field', 'keeper')), names text[] not null,
  "values" text[] not null, refreshed_at timestamptz not null default now(),
  primary key (espn_id, league_slug, team_id, season_year, split_name, kind)
);

CREATE OR REPLACE FUNCTION public.panini_soccer_competition(p_product text)
returns table (league_slug text, season_year int)
language sql immutable
set search_path = pg_catalog, public
as $$
  select l.slug, substring(p_product from '^((?:19|20)\d{2})')::int
    from (select case
                   when p_product ~* 'women' then null
                   when p_product ~* 'laliga' then 'esp.1'
                   when p_product ~* 'serie a' then 'ita.1'
                   when p_product ~* 'ligue 1|foot fr' then 'fra.1'
                   when p_product ~* 'world cup' and p_product !~* 'road to|saga|qualif' then 'fifa.world'
                 end as slug) l
   where l.slug is not null
     and substring(p_product from '^((?:19|20)\d{2})') is not null
$$;

CREATE OR REPLACE FUNCTION public.espn_soccer_card_needs()
returns table (espn_id text, league_slug text)
language sql stable
set search_path = pg_catalog, public
as $$
  select distinct x.espn_id, c.league_slug
    from public.editions e
    join public.panini_products p
      on p.set_id::text = substring(e.external_id from '^packcard-(\d+)_')
     and p.last_grid_sport ilike '%soccer%'
    cross join lateral public.panini_soccer_competition(p.name) c
    join public.panini_espn_crosswalk x
      on x.sport = 'soccer' and x.espn_id is not null
     and x.name_slug = trim(both '-' from regexp_replace(lower(extensions.unaccent(btrim(e.player_name))), '[^a-z0-9]+', '-', 'g'))
   where e.collection_id = (select id from public.collections where slug = 'panini_blockchain')
$$;

CREATE OR REPLACE FUNCTION public.espn_soccer_athlete_stats_dispatch(p_limit int default 60)
returns int
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  r     record;
  v_req bigint;
  v_n   int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_soccer_athlete_stats_dispatch')::bigint) then
    return 0;
  end if;
  for r in
    with needs as (select * from public.espn_soccer_card_needs()),
    cand as (
      -- discovery first: it names the teams the league requests need
      select n.espn_id, ''::text as league_slug, ''::text as team_id, 0 as pri
        from (select distinct espn_id from needs) n
      union all
      select d.espn_id, n.league_slug, t.team_id, 1
        from public.espn_soccer_athlete_fetches d
        cross join lateral unnest(d.team_ids) t(team_id)
        join (select distinct espn_id, league_slug from needs) n on n.espn_id = d.espn_id
       where d.league_slug = '' and d.team_id = '' and d.status = 'ok'
    )
    select c.espn_id, c.league_slug, c.team_id
      from cand c
      left join public.espn_soccer_athlete_fetches f
        on f.espn_id = c.espn_id and f.league_slug = c.league_slug and f.team_id = c.team_id
     where f.espn_id is null
        or (f.status = 'error' and f.attempts < 3 and coalesce(f.fetched_at, f.requested_at) < now() - interval '1 hour')
        or (f.status = 'requested' and f.attempts < 3 and f.requested_at < now() - interval '1 hour')
     order by c.pri, c.espn_id, c.league_slug, c.team_id
     limit greatest(1, least(coalesce(p_limit, 60), 120))
  loop
    v_req := net.http_get(
      'https://site.web.api.espn.com/apis/common/v3/sports/soccer/athletes/' || r.espn_id || '/stats'
      || case when r.league_slug = '' then '' else '?league=' || r.league_slug || '&team=' || r.team_id end);
    insert into public.espn_soccer_athlete_fetches as f (espn_id, league_slug, team_id, status, request_id, requested_at, attempts)
    values (r.espn_id, r.league_slug, r.team_id, 'requested', v_req, now(), 1)
    on conflict (espn_id, league_slug, team_id) do update
       set status = 'requested', request_id = excluded.request_id, requested_at = now(), attempts = f.attempts + 1;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

CREATE OR REPLACE FUNCTION public.espn_soccer_athlete_stats_drain()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_started  timestamptz := clock_timestamp();
  q          record;
  v_body     jsonb;
  v_team     text;
  v_league   text;
  v_kept     int;
  v_stamp    timestamptz;
  v_reqs     int := 0;
  v_errs     int := 0;
  v_rows     int := 0;
  v_err_text text;
  v_error    text;
  v_ok       boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_soccer_athlete_stats_drain')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  for q in
    select f.espn_id, f.league_slug, f.team_id, r0.status_code, r0.content, r0.error_msg, r0.timed_out
      from public.espn_soccer_athlete_fetches f
      left join net._http_response r0 on r0.id = f.request_id
     where f.status = 'requested'
       and (r0.id is not null or f.requested_at < now() - interval '10 minutes')
     order by f.requested_at
     limit 120
  loop
    v_reqs := v_reqs + 1;
    begin
      if q.status_code = 404 then
        -- ESPN has no statistics for this athlete (or this team × league): a fact, not a failure
        update public.espn_soccer_athlete_fetches
           set status = 'none', fetched_at = now(), lines = 0, last_error = null
         where espn_id = q.espn_id and league_slug = q.league_slug and team_id = q.team_id;
        continue;
      end if;
      if q.status_code is null or q.status_code <> 200 or q.timed_out then
        raise exception 'espn soccer stats % % % (%): %', q.espn_id, q.league_slug, q.team_id,
          coalesce(q.status_code::text, 'no-response'), left(coalesce(q.error_msg, q.content, ''), 120);
      end if;
      v_body := q.content::jsonb;
      select f->>'value' into v_team   from jsonb_array_elements(coalesce(v_body->'filters', '[]'::jsonb)) f where f->>'name' = 'team' limit 1;
      select f->>'value' into v_league from jsonb_array_elements(coalesce(v_body->'filters', '[]'::jsonb)) f where f->>'name' = 'league' limit 1;

      if q.league_slug = '' then
        update public.espn_soccer_athlete_fetches
           set status = 'ok', fetched_at = now(), last_error = null,
               team_ids = (select coalesce(array_agg(distinct o->>'value'), '{}'::text[])
                             from jsonb_array_elements(coalesce(v_body->'filters', '[]'::jsonb)) f
                             cross join lateral jsonb_array_elements(coalesce(f->'options', '[]'::jsonb)) o
                            where f->>'name' = 'team' and o->>'value' ~ '^\d+$'),
               teams = (select coalesce(jsonb_object_agg(o->>'value', o->>'displayValue'), '{}'::jsonb)
                          from jsonb_array_elements(coalesce(v_body->'filters', '[]'::jsonb)) f
                          cross join lateral jsonb_array_elements(coalesce(f->'options', '[]'::jsonb)) o
                         where f->>'name' = 'team' and o->>'value' ~ '^\d+$')
         where espn_id = q.espn_id and league_slug = '' and team_id = '';
        continue;
      end if;

      -- ESPN answers an unknown team × league with ANOTHER one (the athlete's default): never store it
      if v_team is distinct from q.team_id or v_league is distinct from q.league_slug then
        update public.espn_soccer_athlete_fetches
           set status = 'mismatch', fetched_at = now(), lines = 0,
               last_error = left(format('answered team %s league %s', coalesce(v_team, '?'), coalesce(v_league, '?')), 300)
         where espn_id = q.espn_id and league_slug = q.league_slug and team_id = q.team_id;
        continue;
      end if;

      -- write first, then retire only what this answer did not write (stamped with the clock, not
      -- now(): now() is the transaction's start and would read every row just written as older)
      v_stamp := clock_timestamp();
      insert into public.espn_soccer_athlete_lines as l
        (espn_id, league_slug, team_id, team_slug, season_year, split_name, kind, names, "values", refreshed_at)
      select q.espn_id, q.league_slug, q.team_id, s->>'teamSlug', (s->'season'->>'year')::int,
             coalesce(s->'season'->>'displayName', ''),
             case when c->'names' ? 'SV' or c->'names' ? 'GA' then 'keeper' else 'field' end,
             array(select jsonb_array_elements_text(c->'names')),
             array(select jsonb_array_elements_text(s->'stats')),
             v_stamp
        from jsonb_array_elements(coalesce(v_body->'categories', '[]'::jsonb)) c
        cross join lateral jsonb_array_elements(coalesce(c->'statistics', '[]'::jsonb)) s
       where s->'season'->>'year' ~ '^\d{4}$'
         and jsonb_typeof(c->'names') = 'array' and jsonb_typeof(s->'stats') = 'array'
         and jsonb_array_length(c->'names') = jsonb_array_length(s->'stats')
      on conflict (espn_id, league_slug, team_id, season_year, split_name, kind) do update
         set team_slug = excluded.team_slug, names = excluded.names, "values" = excluded."values", refreshed_at = excluded.refreshed_at;
      get diagnostics v_kept = row_count;
      delete from public.espn_soccer_athlete_lines l
       where l.espn_id = q.espn_id and l.league_slug = q.league_slug and l.team_id = q.team_id
         and l.refreshed_at < v_stamp;
      v_rows := v_rows + v_kept;

      update public.espn_soccer_athlete_fetches
         set status = 'ok', fetched_at = now(), lines = v_kept, last_error = null
       where espn_id = q.espn_id and league_slug = q.league_slug and team_id = q.team_id;
    -- when-others-timeout-blind: intentional — record this request's failure and continue to the next;
    -- the loop is bounded (120 requests) and a statement_timeout kill of the whole drain leaves every
    -- undrained request 'requested' for the next tick (re-requested after an hour), which is correct.
    exception when others then
      get stacked diagnostics v_err_text = message_text;
      v_errs := v_errs + 1;
      update public.espn_soccer_athlete_fetches
         set status = 'error', fetched_at = now(), last_error = left(v_err_text, 300)
       where espn_id = q.espn_id and league_slug = q.league_slug and team_id = q.team_id;
      v_error := coalesce(v_error || ' | ', '') || left(v_err_text, 200);
    end;
  end loop;

  if v_reqs = 0 then
    return jsonb_build_object('drained', 0);
  end if;

  v_ok := v_errs = 0 or v_errs < v_reqs / 4.0;

  perform public.log_pipeline_run(
    'panini-soccer-season-lines', v_started, v_reqs, v_rows, 0, v_ok, v_error,
    null, null, null,
    jsonb_build_object('requests', v_reqs, 'request_errors', v_errs, 'lines_written', v_rows,
                       'requests_ok', (select count(*) from public.espn_soccer_athlete_fetches where status = 'ok'),
                       'requests_error_total', (select count(*) from public.espn_soccer_athlete_fetches where status = 'error'),
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('ok', v_ok, 'requests', v_reqs, 'errors', v_errs, 'lines', v_rows, 'error', v_error);
end
$$;

CREATE OR REPLACE FUNCTION public.get_panini_card_soccer_line(p_slugs text[], p_external_id text)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_n      int;
  v_espn   text;
  v_league text;
  v_year   int;
  v_teams  jsonb;
begin
  select count(distinct x.espn_id), min(x.espn_id)
    into v_n, v_espn
    from public.panini_espn_crosswalk x
   where x.sport = 'soccer' and x.espn_id is not null and x.name_slug = any (p_slugs);
  if v_n is distinct from 1 then
    return null;
  end if;

  select c.league_slug, c.season_year
    into v_league, v_year
    from public.panini_products p
    cross join lateral public.panini_soccer_competition(p.name) c
   where p.set_id::text = substring(coalesce(p_external_id, '') from '^packcard-(\d+)_')
   limit 1;
  if v_league is null then
    return null;
  end if;

  select f.teams into v_teams
    from public.espn_soccer_athlete_fetches f
   where f.espn_id = v_espn and f.league_slug = '' and f.team_id = '' and f.status = 'ok';

  return jsonb_build_object(
    'espn_id', v_espn,
    'league_slug', v_league,
    'season_year', v_year,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'team_id', l.team_id,
               'team_name', coalesce(v_teams->>l.team_id, nullif(l.team_slug, '')),
               'split_name', l.split_name,
               'kind', l.kind,
               'names', to_jsonb(l.names),
               'values', to_jsonb(l."values")
             ) order by l.team_id, l.split_name, l.kind)
        from public.espn_soccer_athlete_lines l
       where l.espn_id = v_espn and l.league_slug = v_league and l.season_year = v_year), '[]'::jsonb)
  );
end
$$;

-- ── fixtures ────────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.collections VALUES ('00000000-0000-0000-0000-0000000000c1', 'panini_blockchain');
INSERT INTO public.panini_products VALUES
  (2001, '2022 Panini NFT Prizm FIFA World Cup Soccer', 'Soccer'),
  (2002, '2022-23 Panini NFT Select LaLiga Soccer', 'Soccer'),
  (2003, '2023-24 Panini NFT Donruss Soccer', 'Soccer'),
  (2004, '2021-22 Panini NBA Packs', 'Basketball');
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'packcard-2001_1_1_1', 'Lionel Messi'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 'packcard-2002_1_1_1', 'Thibaut Courtois'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000c1', 'packcard-2003_1_1_1', 'Lionel Messi'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000c1', 'packcard-2001_2_1_1', 'Emiliano Martinez');
INSERT INTO public.panini_espn_crosswalk VALUES
  ('lionel-messi', 'soccer', 'Lionel Messi', '45843'),
  ('thibaut-courtois', 'soccer', 'Thibaut Courtois', '134283'),
  ('emiliano-martinez', 'soccer', 'Emiliano Martinez', NULL);

-- (a) the competition of a product
SELECT _assert_eq((SELECT league_slug || ' ' || season_year FROM panini_soccer_competition('2022 Panini NFT Prizm FIFA World Cup Soccer')), 'fifa.world 2022', 'a: men''s World Cup');
SELECT _assert_eq((SELECT league_slug || ' ' || season_year FROM panini_soccer_competition('2022-23 Panini NFT Select LaLiga Soccer')), 'esp.1 2022', 'a: a club season by the year it starts');
SELECT _assert_eq((SELECT league_slug || ' ' || season_year FROM panini_soccer_competition('2025-26 Panini NFT Select Serie A Soccer')), 'ita.1 2025', 'a: Serie A');
SELECT _assert_eq((SELECT league_slug || ' ' || season_year FROM panini_soccer_competition('2021-22 Panini Foot FR Sticker NFT Packs')), 'fra.1 2021', 'a: Foot FR is Ligue 1');
SELECT _assert((SELECT count(*) FROM panini_soccer_competition('2022 Panini NFT Mosaic Road to World Cup FIFA Soccer')) = 0, 'a: qualifiers map to nothing');
SELECT _assert((SELECT count(*) FROM panini_soccer_competition('2023 Panini NFT FIFA World Cup Saga Stickers')) = 0, 'a: a Saga maps to nothing');
SELECT _assert((SELECT count(*) FROM panini_soccer_competition('2023 Panini NFT Women''s World Cup')) = 0, 'a: women''s products map to nothing');
SELECT _assert((SELECT count(*) FROM panini_soccer_competition('2023-24 Panini NFT Donruss Soccer')) = 0, 'a: no competition named');

-- (b) dispatch: discovery first
SELECT _assert_eq(espn_soccer_athlete_stats_dispatch(10)::text, '2', 'b: one discovery per crosswalked athlete with a competition card');
SELECT _assert((SELECT count(*) FROM net._test_requests WHERE url LIKE '%/athletes/45843/stats') = 1, 'b: Messi discovery url');
SELECT _assert((SELECT count(*) FROM net._test_requests WHERE url LIKE '%?%') = 0, 'b: no competition requests before discovery');

-- discovery answers
INSERT INTO net._http_response
SELECT f.request_id, 200, jsonb_build_object('filters', jsonb_build_array(
         jsonb_build_object('name', 'team', 'value', '20232', 'options', jsonb_build_array(
           jsonb_build_object('value', '202', 'displayValue', 'Argentina'),
           jsonb_build_object('value', '83', 'displayValue', 'Barcelona'))),
         jsonb_build_object('name', 'league', 'value', 'usa.1', 'options', '[]'::jsonb)))::text, NULL, false
  FROM espn_soccer_athlete_fetches f WHERE f.espn_id = '45843';
INSERT INTO net._http_response
SELECT f.request_id, 200, jsonb_build_object('filters', jsonb_build_array(
         jsonb_build_object('name', 'team', 'value', '86', 'options', jsonb_build_array(
           jsonb_build_object('value', '86', 'displayValue', 'Real Madrid'))),
         jsonb_build_object('name', 'league', 'value', 'esp.1', 'options', '[]'::jsonb)))::text, NULL, false
  FROM espn_soccer_athlete_fetches f WHERE f.espn_id = '134283';
SELECT espn_soccer_athlete_stats_drain();
SELECT _assert_eq((SELECT array_to_string(team_ids, ',') FROM espn_soccer_athlete_fetches WHERE espn_id = '45843' AND league_slug = ''), '202,83', 'c: discovery keeps every team');

-- (b) then one request per team × NEEDED competition (Messi: fifa.world only — his Donruss card names none)
SELECT _assert_eq(espn_soccer_athlete_stats_dispatch(10)::text, '3', 'b: 2 teams × fifa.world for Messi + 1 × esp.1 for Courtois');
SELECT _assert((SELECT count(*) FROM net._test_requests WHERE url LIKE '%/athletes/45843/stats?league=fifa.world&team=202') = 1, 'b: the WC request for Argentina');
SELECT _assert((SELECT count(*) FROM net._test_requests WHERE url LIKE '%45843%league=esp.1%') = 0, 'b: never a competition no card needs');

-- (c) answers: Argentina × WC is right; Barcelona × WC answered with ANOTHER pair; Courtois 404s once
INSERT INTO net._http_response
SELECT f.request_id, 200, jsonb_build_object(
  'filters', jsonb_build_array(jsonb_build_object('name', 'team', 'value', '202'), jsonb_build_object('name', 'league', 'value', 'fifa.world')),
  'categories', jsonb_build_array(jsonb_build_object('names', jsonb_build_array('STRT','G','A'), 'statistics', jsonb_build_array(
     jsonb_build_object('teamSlug', 'arg', 'season', jsonb_build_object('year', 2022, 'displayName', '2022 FIFA World Cup'), 'stats', jsonb_build_array('7','7','3')),
     jsonb_build_object('teamSlug', 'arg', 'season', jsonb_build_object('year', 2018, 'displayName', '2018 FIFA World Cup'), 'stats', jsonb_build_array('4','1','2'))))))::text, NULL, false
  FROM espn_soccer_athlete_fetches f WHERE f.espn_id = '45843' AND f.team_id = '202';
INSERT INTO net._http_response
SELECT f.request_id, 200, jsonb_build_object(
  'filters', jsonb_build_array(jsonb_build_object('name', 'team', 'value', '20232'), jsonb_build_object('name', 'league', 'value', 'usa.1')),
  'categories', jsonb_build_array(jsonb_build_object('names', jsonb_build_array('STRT','G','A'), 'statistics', jsonb_build_array(
     jsonb_build_object('teamSlug', 'usa.inter_miami', 'season', jsonb_build_object('year', 2022, 'displayName', 'Regular Season'), 'stats', jsonb_build_array('9','9','9'))))))::text, NULL, false
  FROM espn_soccer_athlete_fetches f WHERE f.espn_id = '45843' AND f.team_id = '83';
INSERT INTO net._http_response
SELECT f.request_id, 200, jsonb_build_object(
  'filters', jsonb_build_array(jsonb_build_object('name', 'team', 'value', '86'), jsonb_build_object('name', 'league', 'value', 'esp.1')),
  'categories', jsonb_build_array(
     jsonb_build_object('names', jsonb_build_array('STRT','G','A'), 'statistics', jsonb_build_array(
       jsonb_build_object('teamSlug', 'esp.real_madrid', 'season', jsonb_build_object('year', 2022, 'displayName', '2022-23 Spanish LaLiga'), 'stats', jsonb_build_array('31','0','0')))),
     jsonb_build_object('names', jsonb_build_array('CS','SV','GA'), 'statistics', jsonb_build_array(
       jsonb_build_object('teamSlug', 'esp.real_madrid', 'season', jsonb_build_object('year', 2022, 'displayName', '2022-23 Spanish LaLiga'), 'stats', jsonb_build_array('10','79','29'))))))::text, NULL, false
  FROM espn_soccer_athlete_fetches f WHERE f.espn_id = '134283' AND f.team_id = '86';
SELECT espn_soccer_athlete_stats_drain();
SELECT _assert_eq((SELECT status FROM espn_soccer_athlete_fetches WHERE espn_id = '45843' AND team_id = '83'), 'mismatch', 'c: an answer for another pair is a mismatch');
SELECT _assert((SELECT count(*) FROM espn_soccer_athlete_lines WHERE espn_id = '45843' AND team_id = '83') = 0, 'c: and nothing of it is stored');
SELECT _assert((SELECT count(*) FROM espn_soccer_athlete_lines WHERE espn_id = '45843' AND team_id = '202') = 2, 'c: the right answer is stored, every season');
SELECT _assert_eq((SELECT kind FROM espn_soccer_athlete_lines WHERE espn_id = '134283' AND 'SV' = ANY (names)), 'keeper', 'c: CS/SV/GA is the keeper line');
SELECT _assert((SELECT bool_and(ok) FROM pipeline_runs_test WHERE pipeline = 'panini-soccer-season-lines'), 'c: the runs logged ok');

-- (c) a re-fetch retires what the new answer no longer carries
UPDATE espn_soccer_athlete_fetches SET status = 'requested', request_id = 9001 WHERE espn_id = '45843' AND team_id = '202';
INSERT INTO net._http_response VALUES (9001, 200, jsonb_build_object(
  'filters', jsonb_build_array(jsonb_build_object('name', 'team', 'value', '202'), jsonb_build_object('name', 'league', 'value', 'fifa.world')),
  'categories', jsonb_build_array(jsonb_build_object('names', jsonb_build_array('STRT','G','A'), 'statistics', jsonb_build_array(
     jsonb_build_object('teamSlug', 'arg', 'season', jsonb_build_object('year', 2022, 'displayName', '2022 FIFA World Cup'), 'stats', jsonb_build_array('7','7','3'))))))::text, NULL, false);
SELECT espn_soccer_athlete_stats_drain();
SELECT _assert((SELECT count(*) FROM espn_soccer_athlete_lines WHERE espn_id = '45843' AND team_id = '202') = 1, 'c: a re-fetch retires the season it no longer carries, keeps the one it does');

-- (c) 404 → none; a failure → error
UPDATE espn_soccer_athlete_fetches SET status = 'requested', request_id = 9002 WHERE espn_id = '134283' AND team_id = '86';
INSERT INTO net._http_response VALUES (9002, 404, '{"code":404}', NULL, false);
SELECT espn_soccer_athlete_stats_drain();
SELECT _assert_eq((SELECT status FROM espn_soccer_athlete_fetches WHERE espn_id = '134283' AND team_id = '86'), 'none', 'c: 404 is none');
UPDATE espn_soccer_athlete_fetches SET status = 'requested', request_id = 9003 WHERE espn_id = '134283' AND team_id = '86';
INSERT INTO net._http_response VALUES (9003, 500, 'boom', NULL, false);
SELECT espn_soccer_athlete_stats_drain();
SELECT _assert_eq((SELECT status FROM espn_soccer_athlete_fetches WHERE espn_id = '134283' AND team_id = '86'), 'error', 'c: a failure is error');

-- (d) the reader
SELECT _assert_eq((SELECT get_panini_card_soccer_line(ARRAY['lionel-messi'], 'packcard-2001_1_1_1')->>'season_year'), '2022', 'd: the card''s product season');
SELECT _assert_eq((SELECT get_panini_card_soccer_line(ARRAY['lionel-messi'], 'packcard-2001_1_1_1')->'lines'->0->>'team_name'), 'Argentina', 'd: the team''s display name');
SELECT _assert_eq((SELECT get_panini_card_soccer_line(ARRAY['lionel-messi'], 'packcard-2001_1_1_1')->'lines'->0->'values'->>1), '7', 'd: his 2022 World Cup goals');
SELECT _assert((SELECT jsonb_array_length(get_panini_card_soccer_line(ARRAY['lionel-messi'], 'packcard-2001_1_1_1')->'lines')) = 1, 'd: only that competition-season');
SELECT _assert(get_panini_card_soccer_line(ARRAY['lionel-messi'], 'packcard-2003_1_1_1') IS NULL, 'd: a product with no competition is NULL');
SELECT _assert(get_panini_card_soccer_line(ARRAY['emiliano-martinez'], 'packcard-2001_2_1_1') IS NULL, 'd: an ambiguous player is NULL');
SELECT _assert(get_panini_card_soccer_line(ARRAY['lionel-messi', 'thibaut-courtois'], 'packcard-2001_1_1_1') IS NULL, 'd: two athletes is NULL');

ROLLBACK;
