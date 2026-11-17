-- audit_20261108_espn_search_crosswalk
--
-- Link the players no box score names to an ESPN athlete, through ESPN's own player search
-- (2026-11-08) — so their bio (DOB, birthplace, citizenship, college) and, where they play in an
-- ingested league, their games can be captured too. Before this: UFC Strike 0 of 372 linked;
-- Panini soccer 114 of 2,109 keys ($10.1M of player market cap unlinked), baseball 49 of 314,
-- racing 0 of 89, plus ~370 football / basketball keys; Golazos keys the box scores never name
-- (retired legends, unlisted leagues).
--
-- RULE (a name is not a person): espn_search_queue stores, per (collection, name key, sport), the
-- ESPN search result for the key's words: total player hits and the hits whose accent-folded name
-- slug EQUALS the key in THAT sport. espn_search_crosswalk links only when exactly ONE such hit
-- exists AND ESPN's whole player result set was seen (total_found <= 25 — "Pedro" has 1,741 hits,
-- so a unique-looking first page proves nothing): matched_by 'espn-search-unique'. Otherwise
-- 'ambiguous' (>1 exact hit), 'too_common' (result set not fully seen) or 'no_match'.
--   · UFC Strike and Panini: espn_search_crosswalk is read directly (no game dates to test an era).
--   · Golazos: search hits enter golazos_espn_candidates() as how='search' — only for a key with
--     neither an exact nor a fuzzy box-score candidate — so the DOB era test still decides.
--
-- espn_search_tick() (pg_cron rpc-espn-search, :06 every 10 min): drains search responses,
-- rebuilds the crosswalk, dispatches up to 150 searches. Set-based; logs `espn-search-crosswalk`
-- only on a tick with work (idles once the population is searched; no watchlist row — silence is
-- success). A searched key is not re-searched unless it errored (retry after a day, 3 tries).
--
-- Re-created to read the new crosswalk (bodies otherwise identical to the committed ones):
-- espn_bio_targets, get_player_bio, get_player_recent_games (+ espn_search_crosswalk ids),
-- golazos_espn_candidates (+ search hits), espn_athlete_bio_tick (sport-level ESPN URL when a
-- target has no league segment — MMA search hits carry none).
--
-- Revert:
--   select cron.unschedule('rpc-espn-search');
--   re-apply the 20261108211235 bodies of espn_athlete_bio_tick and get_player_bio, the 20261108210431
--   body of espn_bio_targets, the 20261108201432 body of golazos_espn_candidates and the 20261108184457
--   body of get_player_recent_games; then
--   drop function public.espn_search_tick(); drop function public.espn_search_population();
--   drop table public.espn_search_crosswalk; drop table public.espn_search_queue;
--   select public.refresh_golazos_espn_crosswalk();

create table public.espn_search_queue (
  collection_slug text not null,
  name_slug       text not null,
  sport           text not null,
  player_label    text,
  status          text not null default 'new' check (status in ('new', 'done', 'error')),
  request_id      bigint,
  requested_at    timestamptz,
  fetched_at      timestamptz,
  attempts        int not null default 0,
  total_found     int,
  exact           jsonb,
  last_error      text,
  primary key (collection_slug, name_slug, sport)
);
alter table public.espn_search_queue enable row level security;
revoke all on public.espn_search_queue from anon, authenticated;

create table public.espn_search_crosswalk (
  collection_slug text not null,
  name_slug       text not null,
  sport           text not null,
  player_label    text,
  espn_id         text,
  display_name    text,
  league_slug     text,
  matched_by      text not null check (matched_by in ('espn-search-unique', 'ambiguous', 'too_common', 'no_match')),
  candidates      jsonb,
  matched_at      timestamptz not null default now(),
  primary key (collection_slug, name_slug, sport)
);
alter table public.espn_search_crosswalk enable row level security;
revoke all on public.espn_search_crosswalk from anon, authenticated;

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
       and not exists (select 1 from public.panini_espn_crosswalk x
                        where x.name_slug = m.group_key and x.sport = ps.sport and x.espn_id is not null)
     group by m.group_key, ps.sport
  ), golazos as (
    select 'laliga_golazos'::text, m.group_key, 'soccer'::text, max(m.group_label)
      from public.market_cap_current m
     where m.collection_slug = 'laliga_golazos' and m.grain = 'player' and m.is_primary
       and not exists (select 1 from public.golazos_espn_crosswalk x
                        where x.name_slug = m.group_key and x.candidates::text ~ '"how": "(exact|fuzzy)"')
     group by m.group_key
  )
  select * from ufc union all select * from panini union all select * from golazos
$$;
-- anon-exec: revoked (espn_search_population) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_search_population() from public, anon, authenticated;
grant execute on function public.espn_search_population() to postgres, service_role;

create or replace function public.espn_search_tick()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started   timestamptz := clock_timestamp();
  v_drained   int := 0;
  v_errs      int := 0;
  v_requested int := 0;
  v_xw        jsonb;
  v_ok_run    boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_search_tick')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  -- 1. Drain: total player hits + the hits whose name slug equals the key in the key's sport.
  with r as (
    select q.collection_slug, q.name_slug, q.sport, h.status_code, h.error_msg,
           case when h.status_code = 200 and not coalesce(h.timed_out, false)
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as body
      from public.espn_search_queue q
      left join net._http_response h on h.id = q.request_id
     where q.request_id is not null
       and (h.id is not null or q.requested_at < now() - interval '10 minutes')
  ), p as (
    select r.*,
           (select (t->>'totalFound')::int from jsonb_array_elements(r.body->'resultTypes') t where t->>'type' = 'player' limit 1) as total,
           (select coalesce(jsonb_agg(distinct jsonb_build_object(
                     'espn_id', substring(x->>'uid' from 'a:(\d+)$'), 'name', x->>'displayName',
                     'league', x->>'defaultLeagueSlug')), '[]'::jsonb)
              from jsonb_array_elements(coalesce(r.body->'results', '[]'::jsonb)) res
             cross join lateral jsonb_array_elements(coalesce(res->'contents', '[]'::jsonb)) x
             where res->>'type' = 'player' and x->>'sport' = r.sport
               and public.rpc_name_slug(x->>'displayName') = r.name_slug
               and substring(x->>'uid' from 'a:(\d+)$') is not null) as exact
      from r
  ), u as (
    update public.espn_search_queue q
       set status      = case when p.body is null then 'error' else 'done' end,
           total_found = case when p.body is null then q.total_found else coalesce(p.total, 0) end,
           exact       = case when p.body is null then q.exact else p.exact end,
           fetched_at  = now(),
           request_id  = null,
           last_error  = case when p.body is null
                              then left('espn search ' || coalesce(p.status_code::text, 'no-response') || ' ' || coalesce(p.error_msg, ''), 200) end
      from p
     where q.collection_slug = p.collection_slug and q.name_slug = p.name_slug and q.sport = p.sport
    returning q.status
  )
  select count(*), count(*) filter (where status = 'error') into v_drained, v_errs from u;

  -- 2. Rebuild the UFC / Panini crosswalk from every searched key (Golazos reads the queue through
  --    golazos_espn_candidates and its DOB era test instead).
  if v_drained > 0 then
    with s as (
      select q.collection_slug, q.name_slug, q.sport, q.player_label, q.total_found, q.exact,
             (select count(distinct x->>'espn_id') from jsonb_array_elements(q.exact) x) as n
        from public.espn_search_queue q
       where q.status = 'done' and q.collection_slug in ('ufc_strike', 'panini_blockchain')
    ), v as (
      select s.*,
             case when n = 1 and total_found <= 25 then 'espn-search-unique'
                  when n > 1 then 'ambiguous'
                  when n = 1 then 'too_common'
                  else 'no_match' end as status
        from s
    )
    insert into public.espn_search_crosswalk as c
      (collection_slug, name_slug, sport, player_label, espn_id, display_name, league_slug, matched_by, candidates, matched_at)
    select collection_slug, name_slug, sport, player_label,
           case when status = 'espn-search-unique' then exact->0->>'espn_id' end,
           case when status = 'espn-search-unique' then exact->0->>'name' end,
           case when status = 'espn-search-unique' then exact->0->>'league' end,
           status,
           case when status = 'espn-search-unique' then null else exact || jsonb_build_object('total_found', total_found) end,
           now()
      from v
    on conflict (collection_slug, name_slug, sport) do update set
      player_label = excluded.player_label, espn_id = excluded.espn_id, display_name = excluded.display_name,
      league_slug = excluded.league_slug, matched_by = excluded.matched_by, candidates = excluded.candidates,
      matched_at = case when (c.espn_id, c.matched_by) is distinct from (excluded.espn_id, excluded.matched_by)
                        then now() else c.matched_at end;

    select jsonb_build_object(
             'linked', count(*) filter (where espn_id is not null),
             'ambiguous', count(*) filter (where matched_by = 'ambiguous'),
             'too_common', count(*) filter (where matched_by = 'too_common'),
             'no_match', count(*) filter (where matched_by = 'no_match'),
             'by_collection_sport', (select jsonb_object_agg(k, n) from (
                 select collection_slug || ':' || sport as k, count(*) filter (where espn_id is not null) as n
                   from public.espn_search_crosswalk group by 1) t))
      into v_xw from public.espn_search_crosswalk;
  end if;

  -- 3. Dispatch: never-searched keys first; an error retries after a day, 3 tries max.
  with need as (
    select p.collection_slug, p.name_slug, p.sport, p.player_label
      from public.espn_search_population() p
      left join public.espn_search_queue q
        on q.collection_slug = p.collection_slug and q.name_slug = p.name_slug and q.sport = p.sport
     where q.name_slug is null
        or (q.request_id is null and q.status = 'error' and q.attempts < 3 and q.fetched_at < now() - interval '1 day')
     order by (q.name_slug is not null), p.collection_slug, p.name_slug
     limit 150
  ), req as (
    select n.*,
           net.http_get(format('https://site.web.api.espn.com/apis/search/v2?query=%s&limit=25&type=player',
                               replace(n.name_slug, '-', '%20')),
                        timeout_milliseconds := 15000) as request_id
      from need n
  ), ins as (
    insert into public.espn_search_queue as q (collection_slug, name_slug, sport, player_label, status, request_id, requested_at, attempts)
    select collection_slug, name_slug, sport, player_label, 'new', request_id, now(), 1 from req
    on conflict (collection_slug, name_slug, sport) do update set
      player_label = excluded.player_label, request_id = excluded.request_id, requested_at = now(), attempts = q.attempts + 1
    returning 1
  )
  select count(*) into v_requested from ins;

  if v_drained = 0 and v_requested = 0 then
    return jsonb_build_object('idle', true);
  end if;

  v_ok_run := v_errs = 0 or v_errs < v_drained / 4.0;
  perform public.log_pipeline_run(
    'espn-search-crosswalk', v_started, v_drained + v_requested, v_drained - v_errs, 0, v_ok_run,
    case when v_errs > 0 then v_errs || ' of ' || v_drained || ' ESPN searches failed' end,
    null, null, null,
    jsonb_build_object('drained', v_drained, 'errors', v_errs, 'requested', v_requested, 'crosswalk', v_xw,
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return jsonb_build_object('ok', v_ok_run, 'drained', v_drained, 'errors', v_errs, 'requested', v_requested, 'crosswalk', v_xw);
end
$$;
-- anon-exec: revoked (espn_search_tick) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_search_tick() from public, anon, authenticated;
grant execute on function public.espn_search_tick() to postgres, service_role;

create or replace function public.golazos_espn_candidates()
returns table (name_slug text, player_label text, espn_id text, espn_display_name text, how text)
language sql stable
set search_path = pg_catalog, public
as $$
  with g as (
    select m.group_key as name_slug, max(m.group_label) as player_label
      from public.market_cap_current m
     where m.collection_slug = 'laliga_golazos' and m.grain = 'player' and m.is_primary
     group by m.group_key
  ), e as (
    select distinct a.espn_id, a.display_name, s.slug
      from public.espn_athletes a
      join public.espn_leagues l on l.league = a.league and l.sport = 'soccer'
     cross join lateral (select distinct x from unnest(array[public.rpc_name_slug(a.display_name),
                                                             public.rpc_name_slug(a.full_name)]) x
                          where x is not null) s(slug)
  ), ex as (
    select g.name_slug, g.player_label, e.espn_id, e.display_name, 'exact'::text as how
      from g join e on e.slug = g.name_slug
  ), fz as (
    select g.name_slug, g.player_label, e.espn_id, e.display_name, 'fuzzy'::text as how
      from g
      join e on e.slug like '%-%' and g.name_slug like '%-%'
            and substring(e.slug from '[^-]+$') = substring(g.name_slug from '[^-]+$')
            and length(substring(g.name_slug from '[^-]+$')) >= 4
            and length(split_part(g.name_slug, '-', 1)) >= 4 and length(split_part(e.slug, '-', 1)) >= 4
            and left(split_part(e.slug, '-', 1), 4) = left(split_part(g.name_slug, '-', 1), 4)
     where not exists (select 1 from ex where ex.name_slug = g.name_slug)
  ), sr as (
    -- ESPN search (espn_search_queue) for a key the box scores never named: retired legends and
    -- players in leagues RPC does not ingest. Only when ESPN's whole player result set was seen.
    select g.name_slug, g.player_label, x->>'espn_id', x->>'name', 'search'::text as how
      from g
      join public.espn_search_queue q
        on q.collection_slug = 'laliga_golazos' and q.name_slug = g.name_slug and q.sport = 'soccer'
       and q.status = 'done' and q.total_found <= 25
     cross join lateral jsonb_array_elements(q.exact) x
     where not exists (select 1 from ex where ex.name_slug = g.name_slug)
       and not exists (select 1 from fz where fz.name_slug = g.name_slug)
  )
  select distinct on (name_slug, espn_id) name_slug, player_label, espn_id, display_name, how
    from (select * from ex union all select * from fz union all select * from sr) c
   order by name_slug, espn_id, how
$$;
-- anon-exec: unchanged (golazos_espn_candidates) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

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
  )
  select distinct on (t.sport, t.espn_id) t.sport, t.league_seg, t.espn_id
    from t
   order by t.sport, t.espn_id, t.league_seg nulls last
$$;
-- anon-exec: unchanged (espn_bio_targets) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

create or replace function public.espn_athlete_bio_tick()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started    timestamptz := clock_timestamp();
  v_drained    int := 0;
  v_ok         int := 0;
  v_dob        int := 0;
  v_errs       int := 0;
  v_requested  int := 0;
  v_c_drained  int := 0;
  v_c_errs     int := 0;
  v_c_req      int := 0;
  v_ok_run     boolean;
  v_xwalk      jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_athlete_bio_tick')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  -- 1. Drain athletes: a response that arrived, or an in-flight request older than 10 minutes.
  with r as (
    select b.sport, b.espn_id, h.status_code, h.error_msg,
           case when h.status_code = 200 and not coalesce(h.timed_out, false)
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as body
      from public.espn_athlete_bio b
      left join net._http_response h on h.id = b.request_id
     where b.request_id is not null
       and (h.id is not null or b.requested_at < now() - interval '10 minutes')
  ), p as (
    select r.*,
           case when r.body->>'dateOfBirth' ~ '^\d{4}-\d{2}-\d{2}' then left(r.body->>'dateOfBirth', 10)::date end as dob
      from r
  ), u as (
    update public.espn_athlete_bio b
       set status         = case when p.body is null then (case when b.status = 'ok' then 'ok' else 'error' end)
                                 when p.dob is null then 'no_dob' else 'ok' end,
           date_of_birth  = case when p.body is null then b.date_of_birth else p.dob end,
           display_name   = coalesce(p.body->>'displayName', b.display_name),
           birth_city     = case when p.body is null then b.birth_city else nullif(p.body->'birthPlace'->>'city', '') end,
           birth_state    = case when p.body is null then b.birth_state else nullif(p.body->'birthPlace'->>'state', '') end,
           birth_country  = case when p.body is null then b.birth_country else nullif(p.body->'birthPlace'->>'country', '') end,
           citizenship    = case when p.body is null then b.citizenship else nullif(p.body->>'citizenship', '') end,
           college_id     = case when p.body is null then b.college_id
                                 else substring(p.body->'college'->>'$ref' from '/colleges/(\d+)') end,
           fields_version = case when p.body is null then b.fields_version else 3 end,
           fetched_at     = now(),
           request_id     = null,
           last_error     = case when p.body is null
                                 then left('espn core ' || coalesce(p.status_code::text, 'no-response') || ' ' || coalesce(p.error_msg, ''), 200) end
      from p
     where b.sport = p.sport and b.espn_id = p.espn_id
    returning p.body is not null as answered, p.dob is not null as has_dob
  )
  select count(*), count(*) filter (where answered), count(*) filter (where has_dob), count(*) filter (where not answered)
    into v_drained, v_ok, v_dob, v_errs from u;

  -- 2. Drain colleges.
  with r as (
    select c.college_id, h.status_code, h.error_msg,
           case when h.status_code = 200 and not coalesce(h.timed_out, false)
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as body
      from public.espn_colleges c
      left join net._http_response h on h.id = c.request_id
     where c.request_id is not null
       and (h.id is not null or c.requested_at < now() - interval '10 minutes')
  ), u as (
    update public.espn_colleges c
       set status     = case when r.body is null or r.body->>'name' is null then 'error' else 'ok' end,
           name       = coalesce(r.body->>'name', c.name),
           short_name = coalesce(r.body->>'shortName', c.short_name),
           abbrev     = coalesce(r.body->>'abbrev', c.abbrev),
           fetched_at = now(),
           request_id = null,
           last_error = case when r.body is null or r.body->>'name' is null
                             then left('espn college ' || coalesce(r.status_code::text, 'no-response') || ' ' || coalesce(r.error_msg, ''), 200) end
      from r
     where c.college_id = r.college_id
    returning c.status
  )
  select count(*), count(*) filter (where status = 'error') into v_c_drained, v_c_errs from u;

  -- A stored DOB can settle a pending Golazos link: refresh before dispatching more.
  if v_dob > 0 then
    v_xwalk := public.refresh_golazos_espn_crosswalk();
  end if;

  -- 3. Dispatch athletes: never fetched, fetched before birthplace/college were captured, or an
  --    error due a retry (after a day, 3 tries). Never two requests in flight for one athlete.
  --    fields_version 3 = DOB + birthplace + college + citizenship.
  with need as (
    select t.sport, t.league_seg, t.espn_id
      from public.espn_bio_targets() t
      left join public.espn_athlete_bio b on b.sport = t.sport and b.espn_id = t.espn_id
     where b.espn_id is null
        or (b.request_id is null and b.fields_version < 3 and b.status <> 'error' and b.attempts < 8)
        or (b.request_id is null and b.status = 'error' and b.attempts < 3 and b.fetched_at < now() - interval '1 day')
     order by (b.espn_id is not null), t.sport, t.espn_id
     limit 200
  ), req as (
    select n.sport, n.league_seg, n.espn_id,
           net.http_get(
             case when n.sport = 'soccer' or n.league_seg is null
                  then format('https://sports.core.api.espn.com/v2/sports/%s/athletes/%s', n.sport, n.espn_id)
                  else format('https://sports.core.api.espn.com/v2/sports/%s/leagues/%s/athletes/%s', n.sport, n.league_seg, n.espn_id) end,
             timeout_milliseconds := 15000) as request_id
      from need n
  ), ins as (
    insert into public.espn_athlete_bio as b (sport, espn_id, league_seg, status, request_id, requested_at, attempts)
    select sport, espn_id, league_seg, 'new', request_id, now(), 1 from req
    on conflict (sport, espn_id) do update set
      league_seg = excluded.league_seg, request_id = excluded.request_id, requested_at = now(), attempts = b.attempts + 1
    returning 1
  )
  select count(*) into v_requested from ins;

  -- 4. Dispatch colleges named by any athlete and not yet cached (errors retry after a day, 3 tries).
  with need as (
    select distinct b.college_id
      from public.espn_athlete_bio b
      left join public.espn_colleges c on c.college_id = b.college_id
     where b.college_id is not null
       and (c.college_id is null
            or (c.request_id is null and c.status = 'error' and c.attempts < 3 and c.fetched_at < now() - interval '1 day'))
     order by b.college_id
     limit 100
  ), req as (
    select n.college_id,
           net.http_get(format('https://sports.core.api.espn.com/v2/colleges/%s', n.college_id),
                        timeout_milliseconds := 15000) as request_id
      from need n
  ), ins as (
    insert into public.espn_colleges as c (college_id, status, request_id, requested_at, attempts)
    select college_id, 'new', request_id, now(), 1 from req
    on conflict (college_id) do update set request_id = excluded.request_id, requested_at = now(), attempts = c.attempts + 1
    returning 1
  )
  select count(*) into v_c_req from ins;

  if v_drained = 0 and v_requested = 0 and v_c_drained = 0 and v_c_req = 0 then
    return jsonb_build_object('idle', true);
  end if;

  v_ok_run := (v_errs = 0 or v_errs < v_drained / 4.0) and (v_c_errs = 0 or v_c_errs < v_c_drained / 4.0);
  perform public.log_pipeline_run(
    'espn-athlete-bio', v_started, v_drained + v_requested + v_c_drained + v_c_req, v_ok + v_c_drained - v_c_errs, 0, v_ok_run,
    case when v_errs + v_c_errs > 0
         then v_errs || ' of ' || v_drained || ' athlete and ' || v_c_errs || ' of ' || v_c_drained || ' college lookups failed' end,
    null, null, null,
    jsonb_build_object('athletes_drained', v_drained, 'athletes_answered', v_ok, 'with_dob', v_dob, 'athlete_errors', v_errs,
                       'athletes_requested', v_requested, 'colleges_drained', v_c_drained, 'college_errors', v_c_errs,
                       'colleges_requested', v_c_req, 'golazos_crosswalk', v_xwalk,
                       'targets_without_bio', (select count(*) from public.espn_bio_targets() t
                                                 left join public.espn_athlete_bio b on b.sport = t.sport and b.espn_id = t.espn_id
                                                where b.espn_id is null or b.fields_version < 3),
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return jsonb_build_object('ok', v_ok_run, 'athletes_drained', v_drained, 'athletes_answered', v_ok, 'athlete_errors', v_errs,
                            'athletes_requested', v_requested, 'colleges_drained', v_c_drained, 'college_errors', v_c_errs,
                            'colleges_requested', v_c_req, 'golazos_crosswalk', v_xwalk);
end
$$;
-- anon-exec: unchanged (espn_athlete_bio_tick) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

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
  )
  select jsonb_build_object(
    'linked', (select count(*) from ids),
    'espn', (select jsonb_build_object('espn_id', espn_id, 'date_of_birth', date_of_birth, 'birth_city', birth_city,
                                       'birth_state', birth_state, 'birth_country', birth_country, 'citizenship', citizenship,
                                       'college', college_name, 'college_id', college_id, 'fetched_at', fetched_at)
               from one),
    'onchain', (select jsonb_build_object('date_of_birth', dob, 'birthplace', place) from onchain),
    'nflverse_date_of_birth', (select birth_date from nflverse))
$$;
-- anon-exec: unchanged (get_player_bio) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

create or replace function public.get_player_recent_games(p_collection_slug text, p_slugs text[], p_player_id uuid default null, p_limit int default 5)
returns jsonb language sql stable
set search_path = pg_catalog, public
as $$
  with ids as (
    select distinct pi.espn_id,
           case pi.league when 'nfl' then 'football' when 'mlb' then 'baseball' else 'basketball' end as sport
      from public.player_identities pi
      join public.collections c on c.id = pi.collection_id
     where c.slug = p_collection_slug and pi.espn_id is not null
       and (case when p_player_id is not null then pi.player_id = p_player_id else pi.name_slug = any (p_slugs) end)
    union
    select x.espn_id, 'soccer'
      from public.golazos_espn_crosswalk x
     where p_collection_slug = 'laliga_golazos' and x.espn_id is not null and x.name_slug = any (p_slugs)
    union
    select p.espn_id, p.sport
      from public.panini_espn_crosswalk p
     where p_collection_slug = 'panini_blockchain' and p.espn_id is not null and p.name_slug = any (p_slugs)
    union
    select s.espn_id, s.sport
      from public.espn_search_crosswalk s
     where s.collection_slug = p_collection_slug and s.espn_id is not null and s.name_slug = any (p_slugs)
  ), g as (
    select s.league, s.event_id, s.game_date, s.season,
           max(s.opponent_abbr) as opponent, bool_or(s.is_home) as is_home,
           bool_and(s.did_not_play) as did_not_play, max(s.minutes) as minutes,
           sum(s.fantasy_points) as fantasy_points,
           jsonb_object_agg(case when s.category = '' then 'line' else s.category end, s.stats)
             filter (where s.stats <> '{}'::jsonb) as stats
      from public.player_game_stats s
      join public.espn_leagues l on l.league = s.league
      join ids on ids.espn_id = s.espn_id and ids.sport = l.sport
     where (select count(distinct espn_id) from ids) = 1
     group by s.league, s.event_id, s.game_date, s.season
  ), latest_season as (
    select league, season from g order by game_date desc limit 1
  ), mc as (
    select m.snapshot_date, m.mcap_usd, m.collector_held
      from public.market_cap_daily m
     where m.collection_slug = p_collection_slug and m.grain = 'player' and m.group_key = any (p_slugs)
  ), recent as (
    select g.* from g order by g.game_date desc, g.event_id limit greatest(1, least(coalesce(p_limit, 5), 15))
  )
  select jsonb_build_object(
    'linked', (select count(distinct espn_id) from ids),
    'espn_ids', (select coalesce(jsonb_agg(distinct espn_id), '[]'::jsonb) from ids),
    'season_avg_fp', (select round(avg(g.fantasy_points)::numeric, 2) from g join latest_season ls using (league, season)
                       where not g.did_not_play),
    'games_in_season', (select count(*) from g join latest_season ls using (league, season) where not g.did_not_play),
    'first_game_date', (select min(game_date) from g),
    'mcap_now', (select mcap_usd from mc order by snapshot_date desc limit 1),
    'games', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', r.game_date, 'league', r.league, 'opponent', r.opponent, 'is_home', r.is_home,
               'did_not_play', r.did_not_play, 'minutes', r.minutes, 'fantasy_points', r.fantasy_points,
               'stats', r.stats,
               'mcap_before', (select mcap_usd from mc where snapshot_date = r.game_date - 1 limit 1),
               'mcap_after', (select mcap_usd from mc where snapshot_date = r.game_date + 1 limit 1),
               'held_before', (select collector_held from mc where snapshot_date = r.game_date - 1 limit 1),
               'held_after', (select collector_held from mc where snapshot_date = r.game_date + 1 limit 1))
             order by r.game_date desc, r.event_id)
        from recent r), '[]'::jsonb))
$$;
-- anon-exec: unchanged (get_player_recent_games) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

select cron.schedule('rpc-espn-search', '6,16,26,36,46,56 * * * *', 'select public.espn_search_tick()');