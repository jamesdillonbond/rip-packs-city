-- ================================================================
-- mcp_phase1c_badge_adapter_exception_guard
--
-- Second hot-fix for version 20260512171327. Surfaces upstream errors
-- from get_edition_badges_unified as a gap rather than letting them
-- crash the adapter. The backing RPC currently raises
-- "function unaccent(text) does not exist" because its hardened
-- search_path doesn't include the extensions schema where unaccent
-- now lives — that's a separate backing-RPC bug, tracked outside
-- Track C scope.
-- ================================================================
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

  begin
    v_badges := public.get_edition_badges_unified(v_edition_id);
  exception when others then
    v_badges := null;
    v_gaps := array_append(v_gaps, 'backing_rpc_get_edition_badges_unified_raised_' || regexp_replace(sqlerrm, '[^a-z0-9_]+', '_', 'gi'));
  end;

  if v_badges is null or v_badges = 'null'::jsonb then
    v_gaps := array_append(v_gaps, 'no_badge_data_for_edition');
  end if;
  if v_slug <> 'nba_top_shot' then
    v_gaps := array_append(v_gaps, 'badge_premium_data_only_robust_for_nba_top_shot');
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
