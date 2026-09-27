-- audit_20260927_panini_media_urls_absolute_in_shared_editions
--
-- Panini stores card thumbnails and videos as RELATIVE paths ("pack/1038/thumbnail/…png",
-- "challenge/4772/…mp4") — every one of the 5,101 panini_editions rows, and the bridge copied
-- them verbatim into `editions`. Every shared surface that renders editions.thumbnail_url
-- (entity pages, edition grids, JSON-LD, OG cards, search) would request them from OUR domain.
--
-- The host is MEASURED (2026-09-27, pg_net, see lib/panini/assets.ts): Panini's own SPA builds
-- media URLs on https://assets.paniniamerica.net/catalog/product/ — 50/50 sampled thumbnails
-- 200 image/png, 15/15 videos 200 video/mp4; a nonexistent path 403s (not a catch-all).
--
-- Three pieces:
--   1. public.panini_asset_url(path) — the SQL twin of lib/panini/assets.ts `paniniAssetUrl`:
--      a plain relative path gets the base; a URL already on the base passes through
--      (idempotent); anything else (absolute elsewhere, "//", "..", odd characters) is NULL.
--   2. sync_panini_editions_to_shared — the ONLY writer of Panini editions.thumbnail_url /
--      video_url (pg_proc grep, 2026-09-27) — writes panini_asset_url(...) in those two slots.
--      Body otherwise byte-identical to live (md5 6065bea175f1e721736444d7d432eaba verified
--      against 20260920155903 before editing). CREATE OR REPLACE keeps the ACL.
--   3. One-time backfill of the existing Panini rows in `editions`.
--
-- anon-exec: intentional — a pure IMMUTABLE string function over its argument, reads no table (public.panini_asset_url)
-- anon-exec: intentional — CREATE OR REPLACE keeps the existing ACL (anon/authenticated already revoked; asserted below) (public.sync_panini_editions_to_shared)

CREATE OR REPLACE FUNCTION public.panini_asset_url(p_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_path IS NULL THEN NULL
    WHEN btrim(p_path) LIKE 'https://assets.paniniamerica.net/catalog/product/%'
         AND btrim(p_path) !~ '\.\.' THEN btrim(p_path)
    WHEN btrim(p_path) ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
         AND btrim(p_path) !~ '\.\.'
         AND btrim(p_path) !~ '//' THEN 'https://assets.paniniamerica.net/catalog/product/' || btrim(p_path)
    ELSE NULL
  END
$$;

COMMENT ON FUNCTION public.panini_asset_url(text) IS
  'Absolute URL for a stored Panini media path on the measured host assets.paniniamerica.net/catalog/product/ (idempotent; unsafe input -> NULL). Twin of lib/panini/assets.ts paniniAssetUrl.';

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

  select count(*) into v_src from panini_editions;
  select count(*) into v_rows_multi from panini_editions where btrim(player_name) like '%|%';
  select count(*) into v_rows_entity from panini_editions
   where btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%';

  select count(*) into v_set_collisions from (
    select btrim(regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g'), '-') s
    from panini_editions where nullif(btrim(coalesce(set_name,'')),'') is not null
    group by 1 having count(distinct set_name) > 1
  ) z;

  select count(*) into v_player_collisions from (
    select btrim(regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g'), '-') s
    from panini_editions
    where nullif(btrim(coalesce(player_name,'')),'') is not null
      and btrim(player_name) not like '%|%'
      and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%')
    group by 1 having count(distinct player_name) > 1
  ) z;

  v_collision_blocked := (v_set_collisions > 0 or v_player_collisions > 0);

  select count(distinct set_name) into v_sets_target from panini_editions
   where nullif(btrim(coalesce(set_name,'')),'') is not null;

  select count(distinct btrim(player_name)) into v_players_target from panini_editions
   where nullif(btrim(coalesce(player_name,'')),'') is not null
     and btrim(player_name) not like '%|%'
     and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%');

  select count(*) into v_ed_existing
  from editions e where e.collection_id = v_cid
    and e.external_id in (select pa.external_id from panini_editions pa);

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

  with s as (
    select distinct
      'panini-' || btrim(regexp_replace(lower(btrim(set_name)), '[^a-z0-9]+', '-', 'g'), '-') as ext,
      btrim(set_name) as nm
    from panini_editions where nullif(btrim(coalesce(set_name,'')),'') is not null
  )
  insert into sets (external_id, collection_id, name, created_at, updated_at)
  select ext, v_cid, nm, now(), now() from s
  on conflict (external_id) do update set name = excluded.name, updated_at = now();
  get diagnostics v_sets_written = row_count;

  with p as (
    select distinct
      'panini-' || btrim(regexp_replace(lower(btrim(player_name)), '[^a-z0-9]+', '-', 'g'), '-') as ext,
      btrim(player_name) as nm
    from panini_editions
    where nullif(btrim(coalesce(player_name,'')),'') is not null
      and btrim(player_name) not like '%|%'
      and not (btrim(set_name) ilike 'Team Badges%' or btrim(set_name) ilike 'World Cup Posters%')
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
  from panini_editions pa
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

UPDATE editions
   SET thumbnail_url = public.panini_asset_url(thumbnail_url),
       video_url     = public.panini_asset_url(video_url)
 WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
   AND (thumbnail_url IS DISTINCT FROM public.panini_asset_url(thumbnail_url)
        OR video_url IS DISTINCT FROM public.panini_asset_url(video_url));

-- ── post-apply assertions ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_rel int;
  v_null_new int;
BEGIN
  IF public.panini_asset_url('pack/1/x.png') <> 'https://assets.paniniamerica.net/catalog/product/pack/1/x.png'
     OR public.panini_asset_url('https://assets.paniniamerica.net/catalog/product/pack/1/x.png') <> 'https://assets.paniniamerica.net/catalog/product/pack/1/x.png'
     OR public.panini_asset_url('https://evil.example/x.png') IS NOT NULL
     OR public.panini_asset_url('//evil.example/x.png') IS NOT NULL
     OR public.panini_asset_url('pack/../x.png') IS NOT NULL
     OR public.panini_asset_url('/pack/x.png') IS NOT NULL THEN
    RAISE EXCEPTION 'post-apply: panini_asset_url does not behave as specified';
  END IF;

  SELECT count(*) INTO v_rel FROM editions
   WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     AND (thumbnail_url !~ '^https://' OR video_url !~ '^https://');
  IF v_rel <> 0 THEN
    RAISE EXCEPTION 'post-apply: % Panini editions still carry a relative media path', v_rel;
  END IF;

  -- The backfill must not have NULLed a path that was present (the source had 0 unsafe rows).
  SELECT count(*) INTO v_null_new FROM editions e
    JOIN panini_editions pa ON pa.external_id = e.external_id
   WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     AND ((pa.thumbnail_url IS NOT NULL AND e.thumbnail_url IS NULL)
       OR (pa.video_url IS NOT NULL AND e.video_url IS NULL));
  IF v_null_new <> 0 THEN
    RAISE EXCEPTION 'post-apply: % Panini editions lost a media path', v_null_new;
  END IF;

  IF has_function_privilege('anon', 'public.sync_panini_editions_to_shared(boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sync_panini_editions_to_shared(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-apply: sync_panini_editions_to_shared ACL changed';
  END IF;
END
$verify$;
