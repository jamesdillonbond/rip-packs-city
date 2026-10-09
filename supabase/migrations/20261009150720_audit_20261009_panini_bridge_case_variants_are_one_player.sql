-- audit_20261009_panini_bridge_case_variants_are_one_player
--
-- 2026-10-09 ~8:00 AM PT (Claude Code, cloud). Sentinel WARN: panini-bridge-sync had not
-- succeeded since 2:44 AM PT; every run from 3:14 AM PT raised
--   "refusing to write -- 0 set and 1 player slug collisions would merge distinct entities".
--
-- MEASURED. The one collision is slug 'in-beom-hwang': five cards read "In-beom Hwang" and one
-- (Base Prizms Cracked Ice, packcard-2332_492193_12680332_283) "In-Beom Hwang". That row's
-- player_name was rewritten by the Panini walk at 3:03 AM PT (updated_at = last_seen_at); the
-- other five were last walked 10-04. So the source spells one person two ways per CARD, and
-- the next walk can flip it again — fixing the row would not stay fixed.
--
-- WHAT THIS DOES. Spellings that differ only in CASE are one entity: the collision gate (and
-- the dry-run targets) count distinct lower(btrim(name)), and the sets/players upserts write ONE
-- name per slug — the spelling most cards carry, ties to the lowest — so a case variant can no
-- longer put two rows for one external_id into one upsert. Anything else that maps to the same
-- slug (punctuation, spacing, diacritics stripped by the slug regex) still REFUSES, unchanged.
-- editions.player_name keeps the source's per-card spelling, as before.
--
-- anon-exec: unchanged (sync_panini_editions_to_shared) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-10-09).
--
-- Base verified: live prosrc md5 (whitespace-normalised) f744c19ae82aef610df337dd91882ec7 =
-- the body in 20260929024339, the newest migration defining this function.
--
-- REVERT: re-apply the sync_panini_editions_to_shared block of
-- 20260929024339_audit_20260928_panini_wc_scope_before_other_products.sql verbatim.

create or replace function public.sync_panini_editions_to_shared(p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- The exit condition from docs/strategy/panini-go-live-2026-09-19.md §4 step 1, as a number the
  -- function enforces rather than a sentence it quotes. Moving it is a new migration, on purpose.
  MAX_STALE_PCT constant numeric := 1.0;

  v_cid uuid;
  v_slug text;
  v_src int := 0;
  v_set_collisions int := 0;
  v_player_collisions int := 0;
  v_sets_target int := 0;
  v_players_target int := 0;
  v_ed_existing int := 0;
  v_rows_multi int := 0;
  v_rows_entity int := 0;
  v_sets_written int := 0;
  v_players_written int := 0;
  v_ed_written int := 0;
  v_unlinked int := 0;
  v_stale_pct numeric;
  v_stale_n bigint;
  v_cov_total bigint;
  v_stale_blocked boolean;
  v_collision_blocked boolean;
begin
  select id, slug into v_cid, v_slug from collections where slug = 'panini_blockchain';
  if v_cid is null then
    raise exception 'sync_panini_editions_to_shared: collections row slug=panini_blockchain not found';
  end if;

  -- ACCURACY GATE, read FAIL-CLOSED. Three ways this read can fail to mean what it says, and all
  -- three must refuse rather than permit: no row at all, a NULL percentage, or a zero denominator
  -- (a percentage over no editions is not 0% stale, it is no measurement).
  select pct_editions_stale_45d, editions_stale_45d, total_editions
    into v_stale_pct, v_stale_n, v_cov_total
  from panini_coverage_summary;

  if not found or v_stale_pct is null or v_cov_total is null or v_cov_total = 0 then
    raise exception 'sync_panini_editions_to_shared: refusing to proceed -- panini_coverage_summary did not yield a usable staleness reading (pct=%, total=%). A failed read is not permission.',
      v_stale_pct, v_cov_total;
  end if;

  v_stale_blocked := (v_stale_pct > MAX_STALE_PCT);

  select count(*) into v_src from panini_wc_editions;
  select count(*) into v_rows_multi from panini_wc_editions where btrim(player_name) like '%|%';
  select count(*) into v_rows_entity from panini_wc_editions
   where btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%';

  select count(*) into v_set_collisions from (
    select btrim(regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g'), '-') s
    from panini_wc_editions where nullif(btrim(coalesce(set_name,'')),'') is not null
    group by 1 having count(distinct lower(btrim(set_name))) > 1
  ) z;

  select count(*) into v_player_collisions from (
    select btrim(regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g'), '-') s
    from panini_wc_editions
    where nullif(btrim(coalesce(player_name,'')),'') is not null
      and btrim(player_name) not like '%|%'
      and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%')
    group by 1 having count(distinct lower(btrim(player_name))) > 1
  ) z;

  v_collision_blocked := (v_set_collisions > 0 or v_player_collisions > 0);

  select count(distinct lower(btrim(set_name))) into v_sets_target from panini_wc_editions
   where nullif(btrim(coalesce(set_name,'')),'') is not null;

  select count(distinct lower(btrim(player_name))) into v_players_target from panini_wc_editions
   where nullif(btrim(coalesce(player_name,'')),'') is not null
     and btrim(player_name) not like '%|%'
     and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%');

  select count(*) into v_ed_existing
  from editions e where e.collection_id = v_cid
    and e.external_id in (select pa.external_id from panini_wc_editions pa);

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true,
      'collection_id', v_cid,
      'source_panini_editions', v_src,
      'would_upsert_sets', v_sets_target,
      'would_upsert_players', v_players_target,
      'would_insert_editions', v_src - v_ed_existing,
      'would_update_editions', v_ed_existing,
      'rows_dual_player_card', v_rows_multi,
      'rows_entity_card', v_rows_entity,
      'rows_left_without_player_link', v_rows_multi + v_rows_entity,
      'set_slug_collisions', v_set_collisions,
      'player_slug_collisions', v_player_collisions,
      -- The staleness gate REPORTS here and RAISES below. Both halves read the same variables, so
      -- a dry run cannot say "clear" about a live run that would refuse.
      'source_pct_stale_45d', v_stale_pct,
      'source_editions_stale_45d', v_stale_n,
      'max_stale_pct', MAX_STALE_PCT,
      'blocked_by_staleness', v_stale_blocked,
      'blocked_by_collisions', v_collision_blocked,
      'blocked', (v_stale_blocked or v_collision_blocked),
      'note', 'The staleness threshold is enforced, not advisory. It does NOT answer the editorial question: a live run makes a listing-gated index (pct_trustworthy ~35%) a full citizen of the shared catalog, and no threshold here measures that.'
    );
  end if;

  if v_stale_blocked then
    -- No literal percent signs in this string. In a plpgsql `raise`, `%%%` is scanned left to
    -- right as `%%` (literal) + `%` (placeholder), so it renders the sign BEFORE the value.
    raise exception 'sync_panini_editions_to_shared: refusing to write -- stale share is % percent (% of % editions not re-priced in 45+ days), above the ceiling of % percent. Bridging now puts stale prices into every cross-collection rollup, where nothing can tell them from live ones.',
      v_stale_pct, v_stale_n, v_cov_total, MAX_STALE_PCT;
  end if;

  if v_collision_blocked then
    raise exception 'sync_panini_editions_to_shared: refusing to write -- % set and % player slug collisions would merge distinct entities',
      v_set_collisions, v_player_collisions;
  end if;

  -- One name per slug. A slug's spellings differ only in CASE here (the collision gate above
  -- refuses anything else), so write the spelling most of its cards carry; ties go to the
  -- lowest. Two rows for one slug would make the upsert hit the same row twice.
  with s as (
    select distinct on (ext) ext, nm
    from (
      select
        'panini-' || btrim(regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g'), '-') as ext,
        btrim(set_name) as nm,
        count(*) as n
      from panini_wc_editions where nullif(btrim(coalesce(set_name,'')),'') is not null
      group by 1, 2
    ) v
    order by ext, n desc, nm
  )
  insert into sets (external_id, collection_id, name, created_at, updated_at)
  select ext, v_cid, nm, now(), now() from s
  on conflict (external_id) do update set name = excluded.name, updated_at = now();
  get diagnostics v_sets_written = row_count;

  with p as (
    select distinct on (ext) ext, nm
    from (
      select
        'panini-' || btrim(regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g'), '-') as ext,
        btrim(player_name) as nm,
        count(*) as n
      from panini_wc_editions
      where nullif(btrim(coalesce(player_name,'')),'') is not null
        and btrim(player_name) not like '%|%'
        and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%')
      group by 1, 2
    ) v
    order by ext, n desc, nm
  )
  insert into players (external_id, collection_id, name, collection, created_at, updated_at)
  select ext, v_cid, nm, v_slug, now(), now() from p
  on conflict (external_id) do update set name = excluded.name, updated_at = now();
  get diagnostics v_players_written = row_count;

  insert into editions (
    external_id, collection_id, name, player_id, set_id, tier, circulation_count,
    thumbnail_url, video_url, first_minted_at, collection, player_name, set_name,
    team_name, created_at, updated_at
  )
  select
    pa.external_id,
    v_cid,
    concat_ws(' - ', nullif(btrim(coalesce(pa.player_name,'')),''), nullif(btrim(coalesce(pa.set_name,'')),'')),
    pl.id,
    st.id,
    pa.tier,
    pa.mint_cap,
    public.panini_asset_url(pa.thumbnail_url),
    public.panini_asset_url(pa.video_url),
    pa.first_minted_at,
    v_slug,
    pa.player_name,
    pa.set_name,
    -- This position USED TO carry the source nation column. A NATION IS NOT A TEAM (go-live doc
    -- gap 3), and that column is not even purely nations: 85 distinct values including host cities
    -- ("Dallas", "Vancouver", "San Francisco Bay Area"), "FIFA", and doubled dual-card values
    -- ("Brazil | Brazil"). team_name feeds /[collection]/team/[slug], /my-teams and the team OG
    -- card. (Deliberately not spelling the old expression here: the post-apply assertion greps the
    -- installed body for it, and pg_get_functiondef includes comments.)
    null::text,
    now(),
    now()
  from panini_wc_editions pa
  left join players pl
    on btrim(pa.player_name) not like '%|%'
   and not (btrim(pa.set_name) ilike 'Team Badges%' or btrim(pa.set_name) ilike 'World Cup Posters%')
   and pl.external_id = 'panini-' || btrim(regexp_replace(lower(btrim(pa.player_name)), '[^a-z0-9]+', '-', 'g'), '-')
  left join sets st
    on st.external_id = 'panini-' || btrim(regexp_replace(lower(btrim(pa.set_name)), '[^a-z0-9]+', '-', 'g'), '-')
  on conflict (external_id, collection_id) do update set
    name              = excluded.name,
    player_id         = coalesce(excluded.player_id, editions.player_id),
    set_id            = coalesce(excluded.set_id, editions.set_id),
    tier              = excluded.tier,
    circulation_count = excluded.circulation_count,
    thumbnail_url     = coalesce(excluded.thumbnail_url, editions.thumbnail_url),
    video_url         = coalesce(excluded.video_url, editions.video_url),
    player_name       = excluded.player_name,
    set_name          = excluded.set_name,
    -- excluded.team_name is now always NULL, so this never erases a value a later, deliberate
    -- team mapping puts there.
    team_name         = coalesce(excluded.team_name, editions.team_name),
    updated_at        = now();
  get diagnostics v_ed_written = row_count;

  select count(*) into v_unlinked
  from editions e where e.collection_id = v_cid and e.player_id is null;

  return jsonb_build_object(
    'dry_run', false,
    'collection_id', v_cid,
    'sets_upserted', v_sets_written,
    'players_upserted', v_players_written,
    'editions_upserted', v_ed_written,
    'editions_without_player_link', v_unlinked,
    'expected_without_player_link', v_rows_multi + v_rows_entity,
    'source_pct_stale_45d_at_write', v_stale_pct
  );
end;
$function$;
