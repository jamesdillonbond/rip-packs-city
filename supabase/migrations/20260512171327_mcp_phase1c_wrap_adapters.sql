-- ================================================================
-- mcp_phase1c_wrap_adapters
--
-- Phase 1c of Flow Agents integration. Four service_role-only SECDEF
-- adapters that translate external identifiers (edition_key,
-- collection_slug, dist_id, set_id) into the internal uuid types
-- consumed by the existing live-DB business-logic RPCs, then delegate.
--
-- Backing RPCs (do not duplicate their logic here):
--   get_fmv_for_editions(p_collection_id uuid, p_edition_ids uuid[])
--   compute_pack_ev_from_pool(p_collection_id uuid, p_dist_id text,
--                             p_pack_price numeric, p_slots integer)
--   get_edition_badges_unified(p_edition_id uuid)
--   get_topshot_set_progress(p_wallet text, p_collection_id uuid)
--   get_allday_set_progress(p_wallet text, p_collection_id uuid)
--
-- Wrap discipline: each adapter is a thin translation layer. Where the
-- upstream RPC's shape doesn't match what an agent caller needs (e.g.
-- set-progress emits top-5 missingPreview instead of the full missing
-- list), the adapter composes additional read-only SQL — it never
-- reimplements pricing, badge, or set-progress business logic.
--
-- All adapters return jsonb with a `gaps text[]` field so the worker
-- can honestly report missing coverage rather than padding with zeros.
-- Gap format: `<dimension>_<reason>` for agent pattern-matching.
-- ================================================================

-- ----------------------------------------------------------------
-- mcp_get_fmv(p_edition_key text, p_collection_slug text,
--             p_serial integer default null)
--
-- External-id translation:
--   p_collection_slug → collections.slug → collection_id (uuid)
--   p_edition_key     → editions.external_id within collection → edition_id (uuid)
--
-- Two args required because external_id is NOT globally unique —
-- AllDay and Golazos share plain-int external_ids ("1", "10", etc.).
-- Worker MUST pass both.
--
-- Returns the canonical fmv_snapshots fields directly. p10/p50/p90 are
-- NOT stored in fmv_snapshots (point estimates only); the rich
-- distribution-shape signal comes from wap_usd, wap_without_outliers,
-- sales_count_30d, days_since_sale, and liquidity_rating. The gap
-- "percentile_distribution_not_persisted" is always populated so
-- agents know not to expect percentiles from this surface.
-- ----------------------------------------------------------------
create or replace function public.mcp_get_fmv(
  p_edition_key text,
  p_collection_slug text,
  p_serial integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_slug text := lower(trim(p_collection_slug));
  v_collection_id uuid;
  v_edition_id uuid;
  v_snap public.fmv_snapshots%rowtype;
  v_gaps text[] := array[]::text[];
  v_serial_mult numeric;
  v_adjusted numeric;
begin
  if p_edition_key is null or p_edition_key = '' then
    return jsonb_build_object('error', 'edition_key_required',
                              'gaps', to_jsonb(array['edition_key_required']));
  end if;

  select id into v_collection_id from public.collections where slug = v_slug;
  if v_collection_id is null then
    return jsonb_build_object('error', 'unknown_collection_slug',
                              'collection_slug', v_slug,
                              'gaps', to_jsonb(array['unknown_collection_slug_' || coalesce(v_slug,'null')]));
  end if;

  select id into v_edition_id from public.editions
   where collection_id = v_collection_id and external_id = p_edition_key;
  if v_edition_id is null then
    return jsonb_build_object('error', 'edition_not_found',
                              'edition_key', p_edition_key,
                              'collection_slug', v_slug,
                              'gaps', to_jsonb(array['edition_not_found_' || p_edition_key]));
  end if;

  select * into v_snap from public.fmv_snapshots
   where edition_id = v_edition_id
   order by computed_at desc
   limit 1;

  v_gaps := v_gaps || 'percentile_distribution_not_persisted';
  if v_snap.edition_id is null then
    v_gaps := v_gaps || 'no_fmv_snapshot_for_edition';
  end if;
  if v_snap.top_shot_ask is null then
    v_gaps := v_gaps || 'top_shot_ask_unavailable';
  end if;
  if v_snap.flowty_ask is null then
    v_gaps := v_gaps || 'flowty_ask_unavailable';
  end if;
  if v_snap.liquidity_rating is null then
    v_gaps := v_gaps || 'liquidity_rating_unavailable';
  end if;
  if v_slug = 'disney_pinnacle' then
    v_gaps := v_gaps || 'pinnacle_direct_ask_not_yet_in_fmv_snapshots';
  end if;

  -- Serial multiplier mirrors lib/serialMultiplier in /api/fmv.
  -- Circulation count is not available here, so position-based smoothing
  -- is skipped — only the bucketed rules apply.
  if p_serial is not null then
    v_serial_mult := case
      when p_serial = 1 then 12.0
      when p_serial <= 10 then 4.5
      when p_serial <= 23 then 2.8
      else 1.0
    end;
    v_adjusted := coalesce(v_snap.fmv_usd, 0) * v_serial_mult;
  end if;

  return jsonb_build_object(
    'edition_id', v_edition_id,
    'collection_slug', v_slug,
    'external_id', p_edition_key,
    'fmv_usd', v_snap.fmv_usd,
    'wap_usd', v_snap.wap_usd,
    'wap_without_outliers', v_snap.wap_without_outliers,
    'floor_price_usd', v_snap.floor_price_usd,
    'ask_proxy_fmv', v_snap.ask_proxy_fmv,
    'sales_count_7d', v_snap.sales_count_7d,
    'sales_count_30d', v_snap.sales_count_30d,
    'unique_buyers_30d', v_snap.unique_buyers_30d,
    'days_since_sale', v_snap.days_since_sale,
    'top_shot_ask', v_snap.top_shot_ask,
    'flowty_ask', v_snap.flowty_ask,
    'cross_market_ask', v_snap.cross_market_ask,
    'liquidity_rating', v_snap.liquidity_rating,
    'confidence', v_snap.confidence::text,
    'algo_version', v_snap.algo_version,
    'computed_at', v_snap.computed_at,
    'serial', p_serial,
    'serial_mult', v_serial_mult,
    'adjusted_fmv', v_adjusted,
    'gaps', to_jsonb(v_gaps)
  );
end;
$fn$;

revoke all on function public.mcp_get_fmv(text, text, integer) from public;
grant execute on function public.mcp_get_fmv(text, text, integer) to service_role;
comment on function public.mcp_get_fmv(text, text, integer) is
  'MCP adapter. Resolves (edition_key, collection_slug) -> editions.id and returns the latest fmv_snapshots row. p10/p50/p90 are not persisted; gaps array always includes percentile_distribution_not_persisted. service_role only.';

-- ----------------------------------------------------------------
-- mcp_compute_pack_ev(p_dist_id text)
--
-- External-id translation:
--   p_dist_id → pack_distributions.dist_id (row lookup)
--   pack_distributions.collection_id (already uuid)
--   pack_distributions.metadata->>'retail_price_usd' → p_pack_price
--   pack_distributions.metadata->>'number_of_pack_slots' → p_slots
--
-- All four inputs to compute_pack_ev_from_pool come from one
-- pack_distributions row. No additional caller input required.
-- ----------------------------------------------------------------
create or replace function public.mcp_compute_pack_ev(p_dist_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_pd record;
  v_pack_price numeric;
  v_slots integer;
  v_ev jsonb;
  v_gaps text[] := array[]::text[];
begin
  if p_dist_id is null or p_dist_id = '' then
    return jsonb_build_object('error', 'dist_id_required',
                              'gaps', to_jsonb(array['dist_id_required']));
  end if;

  select pd.dist_id, pd.collection_id, pd.title, pd.total_minted, pd.total_opened,
         pd.depletion_pct, pd.metadata, c.slug as col_slug
    into v_pd
    from public.pack_distributions pd
    join public.collections c on c.id = pd.collection_id
    where pd.dist_id = p_dist_id
    limit 1;

  if v_pd is null then
    return jsonb_build_object('error', 'pack_not_found', 'dist_id', p_dist_id,
                              'gaps', to_jsonb(array['pack_not_found_' || p_dist_id]));
  end if;

  v_pack_price := nullif(v_pd.metadata->>'retail_price_usd','')::numeric;
  v_slots := nullif(v_pd.metadata->>'number_of_pack_slots','')::integer;

  if v_pack_price is null then
    v_gaps := v_gaps || 'pack_price_missing_from_metadata';
  end if;
  if v_slots is null then
    v_gaps := v_gaps || 'slots_missing_from_metadata';
  end if;

  if v_pack_price is not null and v_slots is not null then
    begin
      v_ev := public.compute_pack_ev_from_pool(v_pd.collection_id, p_dist_id, v_pack_price, v_slots);
    exception when others then
      v_ev := null;
      v_gaps := v_gaps || 'compute_pack_ev_from_pool_raised_' || regexp_replace(sqlerrm, '[^a-z0-9_]+', '_', 'gi');
    end;
  else
    v_ev := null;
    v_gaps := v_gaps || 'ev_skipped_missing_inputs';
  end if;

  return jsonb_build_object(
    'dist_id', v_pd.dist_id,
    'collection_slug', v_pd.col_slug,
    'pack_title', v_pd.title,
    'pack_price', v_pack_price,
    'slots', v_slots,
    'total_minted', v_pd.total_minted,
    'total_opened', v_pd.total_opened,
    'depletion_pct', v_pd.depletion_pct,
    'ev', v_ev,
    'gaps', to_jsonb(v_gaps)
  );
end;
$fn$;

revoke all on function public.mcp_compute_pack_ev(text) from public;
grant execute on function public.mcp_compute_pack_ev(text) to service_role;
comment on function public.mcp_compute_pack_ev(text) is
  'MCP adapter. Looks up pack_distributions by dist_id, extracts retail_price_usd + number_of_pack_slots from metadata jsonb, and delegates to compute_pack_ev_from_pool. service_role only.';

-- ----------------------------------------------------------------
-- mcp_get_badge_data(p_edition_key text, p_collection_slug text)
--
-- External-id translation: same as mcp_get_fmv.
-- Delegates to get_edition_badges_unified(edition_id uuid).
-- Non-TopShot collections gap-flagged because badge coverage is
-- TS-centric (badge_editions table is TS-shaped).
-- ----------------------------------------------------------------
create or replace function public.mcp_get_badge_data(
  p_edition_key text,
  p_collection_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_slug text := lower(trim(p_collection_slug));
  v_collection_id uuid;
  v_edition_id uuid;
  v_badges jsonb;
  v_gaps text[] := array[]::text[];
begin
  if p_edition_key is null or p_edition_key = '' then
    return jsonb_build_object('error', 'edition_key_required',
                              'gaps', to_jsonb(array['edition_key_required']));
  end if;

  select id into v_collection_id from public.collections where slug = v_slug;
  if v_collection_id is null then
    return jsonb_build_object('error', 'unknown_collection_slug',
                              'collection_slug', v_slug,
                              'gaps', to_jsonb(array['unknown_collection_slug_' || coalesce(v_slug,'null')]));
  end if;

  select id into v_edition_id from public.editions
   where collection_id = v_collection_id and external_id = p_edition_key;
  if v_edition_id is null then
    return jsonb_build_object('error', 'edition_not_found',
                              'edition_key', p_edition_key,
                              'collection_slug', v_slug,
                              'gaps', to_jsonb(array['edition_not_found_' || p_edition_key]));
  end if;

  v_badges := public.get_edition_badges_unified(v_edition_id);

  if v_badges is null or v_badges = 'null'::jsonb then
    v_gaps := v_gaps || 'no_badge_data_for_edition';
  end if;
  if v_slug <> 'nba_top_shot' then
    v_gaps := v_gaps || 'badge_premium_data_only_robust_for_nba_top_shot';
  end if;

  return jsonb_build_object(
    'edition_id', v_edition_id,
    'collection_slug', v_slug,
    'external_id', p_edition_key,
    'badges', coalesce(v_badges, '{}'::jsonb),
    'gaps', to_jsonb(v_gaps)
  );
end;
$fn$;

revoke all on function public.mcp_get_badge_data(text, text) from public;
grant execute on function public.mcp_get_badge_data(text, text) to service_role;
comment on function public.mcp_get_badge_data(text, text) is
  'MCP adapter. Resolves (edition_key, collection_slug) -> editions.id and delegates to get_edition_badges_unified. Non-TopShot gap-flagged. service_role only.';

-- ----------------------------------------------------------------
-- mcp_find_set_completion(p_wallet text, p_collection_slug text, p_set_id text)
--
-- Supported: nba_top_shot, nfl_all_day.
-- Unsupported (returns {supported:false, reason: ...}):
--   disney_pinnacle, ufc_strike  -> deferred_pending_consistent_signature
--   laliga_golazos               -> set_progress_rpc_not_implemented
--
-- Composes two reads:
--   (1) get_topshot_set_progress / get_allday_set_progress for the
--       set-level overview (set_name, owned_count, total_count, etc.).
--       The upstream RPC returns ALL sets the wallet touches (~370KB
--       jsonb per wallet), so we filter to p_set_id via
--       jsonb_array_elements at the SQL level — never materialize the
--       full payload into the worker.
--   (2) editions + wallet_moments_cache + (badge_editions OR
--       cached_listings) for the FULL missing-edition list, because
--       the upstream RPC only emits a top-5 missingPreview. Each
--       missing row carries cheapest_ask + cheapest_ask_source
--       ("topshot" / "flowty" / null). Rows with null asks are NOT
--       dropped — they are gap-flagged per-edition so agents can still
--       see the full set.
--
-- p_set_id is the editions.set_id uuid (text-coerced for the param).
-- ----------------------------------------------------------------
create or replace function public.mcp_find_set_completion(
  p_wallet text,
  p_collection_slug text,
  p_set_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_slug text := lower(trim(p_collection_slug));
  v_wallet text := lower(trim(p_wallet));
  v_collection_id uuid;
  v_set_uuid uuid;
  v_overview jsonb;
  v_set_obj jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_total_completion numeric;
  v_gaps text[] := array[]::text[];
begin
  if p_wallet is null or p_wallet = '' then
    return jsonb_build_object('supported', false, 'reason', 'wallet_required',
                              'gaps', to_jsonb(array['wallet_required']));
  end if;
  if p_set_id is null or p_set_id = '' then
    return jsonb_build_object('supported', false, 'reason', 'set_id_required',
                              'gaps', to_jsonb(array['set_id_required']));
  end if;

  -- Unsupported collections per Track C directive
  if v_slug = 'disney_pinnacle' or v_slug = 'ufc_strike' then
    return jsonb_build_object(
      'supported', false,
      'reason', 'deferred_pending_consistent_signature',
      'collection_slug', v_slug,
      'set_id', p_set_id,
      'gaps', to_jsonb(array['set_completion_deferred_for_' || v_slug])
    );
  elsif v_slug = 'laliga_golazos' then
    return jsonb_build_object(
      'supported', false,
      'reason', 'set_progress_rpc_not_implemented',
      'collection_slug', v_slug,
      'set_id', p_set_id,
      'gaps', to_jsonb(array['set_completion_unavailable_for_laliga_golazos'])
    );
  end if;

  -- Resolve collection
  select id into v_collection_id from public.collections where slug = v_slug;
  if v_collection_id is null then
    return jsonb_build_object('supported', false, 'reason', 'unknown_collection_slug',
                              'collection_slug', v_slug, 'set_id', p_set_id,
                              'gaps', to_jsonb(array['unknown_collection_slug_' || coalesce(v_slug,'null')]));
  end if;

  -- Parse p_set_id as uuid (editions.set_id is uuid). If it isn't a
  -- uuid we can still return the overview from the underlying RPC,
  -- but we can't compute the full missing list, so we gap-flag.
  begin
    v_set_uuid := p_set_id::uuid;
  exception when invalid_text_representation then
    v_set_uuid := null;
    v_gaps := v_gaps || 'set_id_not_uuid_full_missing_list_skipped';
  end;

  -- Delegate overview
  if v_slug = 'nba_top_shot' then
    v_overview := public.get_topshot_set_progress(v_wallet, v_collection_id);
  elsif v_slug = 'nfl_all_day' then
    v_overview := public.get_allday_set_progress(v_wallet, v_collection_id);
  else
    return jsonb_build_object('supported', false, 'reason', 'unsupported_collection_for_set_completion',
                              'collection_slug', v_slug, 'set_id', p_set_id,
                              'gaps', to_jsonb(array['set_completion_only_supports_topshot_and_allday']));
  end if;

  -- Filter to the requested set at the SQL level — do NOT materialize
  -- the full 370KB payload into the worker response.
  select s into v_set_obj
    from jsonb_array_elements(coalesce(v_overview->'sets', '[]'::jsonb)) s
    where s->>'setId' = p_set_id
    limit 1;

  if v_set_obj is null then
    v_gaps := v_gaps || 'set_not_in_wallet_progress_payload';
  end if;

  -- Full missing list. Skipped only when v_set_uuid couldn't be parsed.
  if v_set_uuid is not null then
    if v_slug = 'nba_top_shot' then
      -- TopShot: badge_editions.low_ask is the canonical ask source
      -- (per CLAUDE.md, get_collection_stats reads be.low_ask not cached_listings).
      with owned_external_ids as (
        select wmc.edition_key
          from public.wallet_moments_cache wmc
         where wmc.collection_id = v_collection_id
           and lower(wmc.wallet_address) = v_wallet
           and wmc.edition_key is not null
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'edition_id', e.id,
               'external_id', e.external_id,
               'player_name', e.player_name,
               'tier', e.tier::text,
               'thumbnail_url', e.thumbnail_url,
               'cheapest_ask', be.low_ask,
               'cheapest_ask_source', case when be.low_ask is not null then 'topshot' else null end
             ) order by be.low_ask asc nulls last), '[]'::jsonb)
        into v_missing
        from public.editions e
        left join public.badge_editions be
          on be.collection_id = v_collection_id and be.external_id = e.external_id
       where e.collection_id = v_collection_id
         and e.set_id = v_set_uuid
         and not exists (
           select 1 from owned_external_ids o where o.edition_key = e.external_id
         );
    elsif v_slug = 'nfl_all_day' then
      -- AllDay: badge_editions.low_ask coverage ~0% (per CLAUDE.md known
      -- issue). Source asks from cached_listings min(ask_price) grouped
      -- by (collection_id, set_name, player_name).
      with owned_external_ids as (
        select wmc.edition_key
          from public.wallet_moments_cache wmc
         where wmc.collection_id = v_collection_id
           and lower(wmc.wallet_address) = v_wallet
           and wmc.edition_key is not null
      ),
      asks as (
        select cl.set_name, cl.player_name,
               min(cl.ask_price) as cheapest_ask,
               (array_agg(cl.source order by cl.ask_price asc nulls last))[1] as cheapest_ask_source
          from public.cached_listings cl
         where cl.collection_id = v_collection_id and cl.ask_price is not null
         group by cl.set_name, cl.player_name
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'edition_id', e.id,
               'external_id', e.external_id,
               'player_name', e.player_name,
               'tier', e.tier::text,
               'thumbnail_url', e.thumbnail_url,
               'cheapest_ask', a.cheapest_ask,
               'cheapest_ask_source', a.cheapest_ask_source
             ) order by a.cheapest_ask asc nulls last), '[]'::jsonb)
        into v_missing
        from public.editions e
        left join asks a on a.set_name = e.set_name and a.player_name = e.player_name
       where e.collection_id = v_collection_id
         and e.set_id = v_set_uuid
         and not exists (
           select 1 from owned_external_ids o where o.edition_key = e.external_id
         );
    end if;
  end if;

  -- total_completion_usd = sum of available cheapest_ask values
  select coalesce(sum((elem->>'cheapest_ask')::numeric), 0)
    into v_total_completion
    from jsonb_array_elements(v_missing) elem
   where elem->>'cheapest_ask' is not null;

  -- Per-edition gap entries for null-ask missing rows (don't drop the row)
  v_gaps := v_gaps || coalesce(
    array(
      select 'cheapest_ask_unavailable_for_' || (elem->>'external_id')
        from jsonb_array_elements(v_missing) elem
       where elem->>'cheapest_ask' is null
    ),
    array[]::text[]
  );

  return jsonb_build_object(
    'supported', true,
    'collection_slug', v_slug,
    'set_id', p_set_id,
    'set_name', v_set_obj->>'setName',
    'set_tier', v_set_obj->>'setTier',
    'series', (v_set_obj->>'series')::int,
    'owned_count', (v_set_obj->>'ownedPlays')::int,
    'total_count', (v_set_obj->>'totalPlays')::int,
    'missing_count', (v_set_obj->>'missingPlays')::int,
    'completion_pct', nullif(v_set_obj->>'completionPct','')::numeric,
    'estimated_cost_to_complete_rpc', nullif(v_set_obj->>'estimatedCostToComplete','')::numeric,
    'total_completion_usd', v_total_completion,
    'missing_editions', v_missing,
    'gaps', to_jsonb(v_gaps)
  );
end;
$fn$;

revoke all on function public.mcp_find_set_completion(text, text, text) from public;
grant execute on function public.mcp_find_set_completion(text, text, text) to service_role;
comment on function public.mcp_find_set_completion(text, text, text) is
  'MCP adapter. Composes get_*_set_progress (set-level overview, filtered by setId) with a direct editions+wmc+(badge_editions|cached_listings) query for the FULL missing-edition list with cheapest_ask + cheapest_ask_source. Top Shot and NFL All Day only; Pinnacle/UFC return supported:false (deferred), Golazos returns supported:false (no upstream RPC). service_role only.';
