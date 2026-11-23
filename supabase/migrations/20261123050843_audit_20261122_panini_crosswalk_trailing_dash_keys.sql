-- APPLIED 2026-11-22 ~9:12 PM PT via the Supabase SQL editor (Chrome), buffer loaded from the committed
-- docs/audits copy at 6c06f46 and SHA-256 checked in-page; history row recorded as version 20261123050843.
-- Verified by MCP read: both bodies carry the fix; refresh_panini_espn_crosswalk() matched 3,309 -> 3,366;
-- 54 trailing-dash keys linked, 10 family_ambiguous (as the dry run predicted); no prior link lost.
--
-- anon-exec: unchanged (refresh_panini_espn_crosswalk) — CREATE OR REPLACE, same signature, invoker-rights; has_function_privilege read after apply 2026-11-22: anon=false, authenticated=false, preserved.
-- anon-exec: unchanged (espn_search_population) — CREATE OR REPLACE, same signature, invoker-rights; has_function_privilege read after apply 2026-11-22: anon=false, authenticated=false, preserved.
--
-- audit_20261122: Panini ESPN crosswalk never linked a player whose name ends in "." (Jr., Sr.)
--
-- Defect (found 2026-11-22 while building the Panini digital<->paper crosswalk):
--   market_cap_current.group_key keeps the dash a trailing "." leaves ("Michael Penix Jr." ->
--   "michael-penix-jr-", the site's player slug). Both readers below join it to
--   rpc_name_slug(player_name), which TRIMS that dash, so `ps.slug = m.group_key` is never true for
--   those keys: all 89 trailing-dash Panini player keys had NO crosswalk row and were never even
--   queued for ESPN search (Bobby Witt Jr., Jaren Jackson Jr., Michael Porter Jr., Ken Griffey Jr., …).
--   Effect: no box scores / recent games on those Panini player pages, and no person link anywhere
--   that reads panini_espn_crosswalk.
-- Fix: compare on trim(both '-' from group_key); the stored name_slug stays the group key, so every
--   reader keyed by the site slug (get_player_recent_games: name_slug = any(p_slugs)) keeps working.
-- Dry run (read-only, 2026-11-22 ~8:45 PM PT) of the fixed match over the 89 keys:
--   67 have ESPN candidates; 54 link (sport-unique-name); 10 stay family_ambiguous BY DESIGN —
--   father/son pairs sharing a base name (Marvin Harrison Jr., Tim Hardaway Jr., Larry Nance Jr.,
--   Ron Harper Jr., Joey Porter Jr., …) are never settled by picking one; the rest are non-people
--   (Rolling Stones song titles) or not in ESPN's index.
-- Pre-apply md5 of pg_get_functiondef: espn_search_population c6f09af126f2cc5dfba0edf6e7bf3f92.
-- Revert: re-apply the previous bodies (only the three marked lines change).
-- After apply: select public.refresh_panini_espn_crosswalk();  -- expect matched to rise by ~54

CREATE OR REPLACE FUNCTION public.refresh_panini_espn_crosswalk()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_started timestamptz := clock_timestamp();
  v_out     jsonb;
begin
  with ps as (
    select public.rpc_name_slug(e.player_name) as slug,
           case when pp.last_grid_sport ilike '%basketball%' then 'basketball' else lower(pp.last_grid_sport) end as sport
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.slug = 'panini_blockchain'
      join public.panini_products pp on pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
     where e.external_id like 'packcard-%' and pp.last_grid_sport is not null
     group by 1, 2
  ), g as (
    select m.group_key as name_slug, max(m.group_label) as player_label, ps.sport,
           trim(both '-' from m.group_key) as gkey,                                             -- audit_20261122
           regexp_replace(trim(both '-' from m.group_key), '-(jr|sr|ii|iii|iv|v)$', '') as gbase -- audit_20261122
      from public.market_cap_current m
      join ps on ps.slug = trim(both '-' from m.group_key)                                      -- audit_20261122
     where m.collection_slug = 'panini_blockchain' and m.grain = 'player' and m.is_primary
     group by m.group_key, ps.sport
  ), cand as (
    select case pi.league when 'nba' then 'basketball' when 'nfl' then 'football' when 'mlb' then 'baseball' end as sport,
           s.slug, regexp_replace(s.slug, '-(jr|sr|ii|iii|iv|v)$', '') as base, pi.espn_id, pi.display_name
      from public.player_identities pi
     cross join lateral (select distinct x from unnest(array[pi.name_slug, public.rpc_name_slug(pi.display_name)]) x
                          where x is not null) s(slug)
     where pi.espn_id is not null
    union
    select l.sport, s.slug, regexp_replace(s.slug, '-(jr|sr|ii|iii|iv|v)$', ''), a.espn_id, a.display_name
      from public.espn_athletes a
      join public.espn_leagues l on l.league = a.league
     cross join lateral (select distinct x from unnest(array[public.rpc_name_slug(a.display_name),
                                                             public.rpc_name_slug(a.full_name)]) x
                          where x is not null) s(slug)
  ), m as (
    select g.name_slug, g.sport, g.player_label,
           count(distinct c.espn_id) filter (where c.slug = g.gkey) as n_exact,
           count(distinct c.espn_id) filter (where c.base = g.gbase) as n_base,
           min(c.espn_id) filter (where c.slug = g.gkey) as espn_id,
           jsonb_agg(distinct jsonb_build_object('espn_id', c.espn_id, 'name', c.display_name)) as candidates
      from g join cand c on c.sport = g.sport and (c.slug = g.gkey or c.base = g.gbase)
     group by g.name_slug, g.sport, g.player_label
  ), v as (
    select name_slug, sport, player_label,
           case when n_exact = 1 and n_base <= 1 then espn_id end as espn_id,
           case when n_exact = 1 and n_base <= 1 then 'sport-unique-name'
                when n_exact > 1 then 'ambiguous'
                else 'family_ambiguous' end as matched_by,
           case when n_exact = 1 and n_base <= 1 then null else candidates end as candidates
      from m
     where n_exact >= 1
  ), d as (
    delete from public.panini_espn_crosswalk x
     where not exists (select 1 from v where v.name_slug = x.name_slug and v.sport = x.sport)
    returning 1
  )
  insert into public.panini_espn_crosswalk as x (name_slug, sport, player_label, espn_id, matched_by, candidates, matched_at)
  select name_slug, sport, player_label, espn_id, matched_by, candidates, now() from v
  on conflict (name_slug, sport) do update set
    player_label = excluded.player_label, espn_id = excluded.espn_id, matched_by = excluded.matched_by,
    candidates = excluded.candidates,
    matched_at = case when (x.espn_id, x.matched_by) is distinct from (excluded.espn_id, excluded.matched_by)
                      then now() else x.matched_at end;

  select jsonb_build_object(
           'matched', count(*) filter (where espn_id is not null),
           'ambiguous', count(*) filter (where matched_by = 'ambiguous'),
           'family_ambiguous', count(*) filter (where matched_by = 'family_ambiguous'),
           'by_sport', (select jsonb_object_agg(sport, n) from (select sport, count(*) filter (where espn_id is not null) n
                                                                 from public.panini_espn_crosswalk group by sport) s))
    into v_out from public.panini_espn_crosswalk;

  perform public.log_pipeline_run(
    'panini-espn-crosswalk', v_started, (v_out->>'matched')::int, (v_out->>'matched')::int, 0,
    (v_out->>'matched')::int > 0, case when (v_out->>'matched')::int > 0 then null else 'zero matches' end,
    null, null, null,
    v_out || jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return v_out;
end
$function$;

CREATE OR REPLACE FUNCTION public.espn_search_population()
 RETURNS TABLE(collection_slug text, name_slug text, sport text, player_label text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
      join ps on ps.slug = trim(both '-' from m.group_key)   -- audit_20261122: group keys keep a trailing "." dash
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
$function$;

insert into supabase_migrations.schema_migrations (version, name) values (to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYYMMDDHH24MISS'), 'audit_20261122_panini_crosswalk_trailing_dash_keys');
