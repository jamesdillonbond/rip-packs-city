-- audit_20261126_panini_soccer_season_lines
--
-- The card slab's back for Panini SOCCER cards (Trevor 2026-11-26: "Yes do it all"). A soccer card
-- has no game; its back shows the player's line in the competition and season its PRODUCT is from:
-- "2022 Panini NFT Prizm FIFA World Cup Soccer" → his 2022 World Cup, "2022-23 Panini NFT Select
-- LaLiga Soccer" → his 2022-23 LALIGA season. 1,245 soccer athletes reach ESPN through
-- panini_espn_crosswalk (sport 'soccer'), and player_season_stats has no soccer at all.
--
-- ESPN (probed 11-26 from pg_net): site.web.api.espn.com/apis/common/v3/sports/soccer/athletes/<id>/stats
--   * with no parameters → the athlete's CURRENT team + league, and `filters` listing every team of
--     his career (club and national) — the discovery request;
--   * ?league=<slug>&team=<id> → that team's seasons in that competition (Messi, fifa.world, team 202:
--     2022 FIFA World Cup 7 G 3 A — right). The answer's own filters say which team/league it is; an
--     answer for another team or league is NOT stored (status 'mismatch').
--   * categories: field players STRT FC FA YC RC G A SHOT SOG OFF; keepers add a second category CS SV GA.
--
--   panini_soccer_competition(text)   product name → (ESPN league slug, ESPN season year), or no row
--   espn_soccer_card_needs()          the (espn_id, league) pairs Panini soccer cards need
--   espn_soccer_athlete_fetches       one row per request: discovery (league '' team '') or league×team
--   espn_soccer_athlete_lines         the lines, one per (athlete, league, team, season, split, kind)
--   espn_soccer_athlete_stats_dispatch()  pg_cron */3 — ≤ 60 requests per run
--   espn_soccer_athlete_stats_drain()     pg_cron 2-59/3 — parse, store, log_pipeline_run('panini-soccer-season-lines')
--   get_panini_card_soccer_line(text[], text)  the reader: a card's line, or NULL (no claim)
--
-- Revert:
--   select cron.unschedule('rpc-panini-soccer-stats-dispatch'); select cron.unschedule('rpc-panini-soccer-stats-drain');
--   delete from public.pipeline_cadence_watchlist where pipeline = 'panini-soccer-season-lines';
--   drop function public.get_panini_card_soccer_line(text[], text);
--   drop function public.espn_soccer_athlete_stats_drain(); drop function public.espn_soccer_athlete_stats_dispatch(int);
--   drop function public.espn_soccer_card_needs(); drop function public.panini_soccer_competition(text);
--   drop table public.espn_soccer_athlete_lines; drop table public.espn_soccer_athlete_fetches;

create table public.espn_soccer_athlete_fetches (
  espn_id      text not null,
  league_slug  text not null,          -- '' = the discovery request
  team_id      text not null,          -- '' = the discovery request
  status       text not null check (status in ('requested', 'ok', 'none', 'mismatch', 'error')),
  request_id   bigint,
  requested_at timestamptz,
  fetched_at   timestamptz,
  attempts     int not null default 0,
  team_ids     text[],                 -- discovery: every team of the athlete's career
  teams        jsonb,                  -- discovery: team id → ESPN display name
  lines        int,
  last_error   text,
  primary key (espn_id, league_slug, team_id)
);

create table public.espn_soccer_athlete_lines (
  espn_id      text not null,
  league_slug  text not null,
  team_id      text not null,
  team_slug    text,
  season_year  int not null,
  split_name   text not null,
  kind         text not null check (kind in ('field', 'keeper')),
  names        text[] not null,
  "values"     text[] not null,
  refreshed_at timestamptz not null default now(),
  primary key (espn_id, league_slug, team_id, season_year, split_name, kind)
);

alter table public.espn_soccer_athlete_fetches enable row level security;
alter table public.espn_soccer_athlete_lines enable row level security;
revoke all on public.espn_soccer_athlete_fetches, public.espn_soccer_athlete_lines from public, anon, authenticated;
grant all on public.espn_soccer_athlete_fetches, public.espn_soccer_athlete_lines to service_role;

-- A Panini soccer PRODUCT's competition and season, as ESPN numbers them. Only products that name ONE
-- competition: LaLiga, Serie A, Ligue 1 (and the French "Foot" stickers), the men's World Cup. Not the
-- Road to the World Cup (qualifiers), not a World Cup "Saga" (history), not women's products, not a
-- product that names no competition ("Donruss Soccer", "Select FIFA") — those return no row.
-- ESPN numbers a club season by the year it STARTS ("2022-23" → 2022) and a World Cup by its year.
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
-- anon-exec: revoked (panini_soccer_competition) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.panini_soccer_competition(text) from public, anon, authenticated;
grant execute on function public.panini_soccer_competition(text) to postgres, service_role;

-- The (athlete, competition) pairs Panini soccer cards need. ~0.5 s, ~7.4k buffers (measured 11-26).
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
-- anon-exec: revoked (espn_soccer_card_needs) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_soccer_card_needs() from public, anon, authenticated;
grant execute on function public.espn_soccer_card_needs() to postgres, service_role;

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
-- anon-exec: revoked (espn_soccer_athlete_stats_dispatch) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_soccer_athlete_stats_dispatch(int) from public, anon, authenticated;
grant execute on function public.espn_soccer_athlete_stats_dispatch(int) to postgres, service_role;

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
-- anon-exec: revoked (espn_soccer_athlete_stats_drain) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.espn_soccer_athlete_stats_drain() from public, anon, authenticated;
grant execute on function public.espn_soccer_athlete_stats_drain() to postgres, service_role;

-- The reader: a Panini soccer card's line, from its PRODUCT's competition and season. NULL when the
-- card's player is not exactly one ESPN athlete, or its product names no competition (no claim either
-- way). Otherwise the competition plus its lines ('[]' when he has none for it). Team names come from
-- the athlete's own discovery answer.
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
-- anon-exec: revoked (get_panini_card_soccer_line) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.get_panini_card_soccer_line(text[], text) from public, anon, authenticated;
grant execute on function public.get_panini_card_soccer_line(text[], text) to postgres, service_role;

insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
values ('panini-soccer-season-lines', 20160, 20160, 'info',
  'Added 2026-11-26 with the Panini soccer card-back lane (espn_soccer_athlete_stats_dispatch every 3 min, drain 2-59/3; pg_net to ESPN''s athlete stats per crosswalked soccer athlete, then per team x competition his cards need). Logs only when it drained requests: a backfill of ~8k requests over several hours, then only new athletes or competitions. ok=false when >=25% of a tick''s requests fail. info until a human read promotes it.',
  true);

select cron.schedule('rpc-panini-soccer-stats-dispatch', '*/3 * * * *',    'select public.espn_soccer_athlete_stats_dispatch()');
select cron.schedule('rpc-panini-soccer-stats-drain',    '2-59/3 * * * *', 'select public.espn_soccer_athlete_stats_drain()');
