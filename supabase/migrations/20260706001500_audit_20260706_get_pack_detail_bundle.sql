-- P3 (2026-07-06): single-RPC shell bundle for the pack-detail page. Collapses the
-- shell-critical reads (pack_table_rows + pack_distributions fallback + AllDay
-- corrected-EV + top-5-by-FMV hero editions for the montage/strip + has_pool) into
-- ONE round-trip / ONE connection, instead of the 10-way per-request Promise.all
-- fan-out that saturated the connection pool (~58 statement-timeouts/24h on the
-- pack-detail route). The heavy below-the-fold sections (lifecycle, realized-EV,
-- ev-contributors, pack-market, sales-history, contents grid, top-pulls) now
-- Suspense-stream on their own connections OFF the critical path.
-- SECURITY DEFINER + service_role only (called via supabaseAdmin from the server page).
-- Revert: DROP FUNCTION public.get_pack_detail_bundle(uuid, text, text);
create or replace function public.get_pack_detail_bundle(
  p_collection_id uuid,
  p_dist_id text,
  p_collection_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
  v_pack_row      jsonb;
  v_dist_fallback jsonb;
  v_corrected_ev  jsonb;
  v_hero          jsonb;
  v_has_pool      boolean;
begin
  select to_jsonb(t) into v_pack_row
  from public.pack_table_rows t
  where t.collection_id = p_collection_id and t.dist_id = p_dist_id
  limit 1;

  select jsonb_build_object('metadata', d.metadata, 'image_url', d.image_url, 'title', d.title)
    into v_dist_fallback
  from public.pack_distributions d
  where d.collection_id = p_collection_id and d.dist_id = p_dist_id
  limit 1;

  if p_collection_slug = 'nfl-all-day' then
    select jsonb_build_object(
             'corrected_gross_ev', v.corrected_gross_ev,
             'corrected_net_ev', v.corrected_net_ev,
             'corrected_value_ratio', v.corrected_value_ratio,
             'ev_method', v.ev_method,
             'has_published_odds', v.has_published_odds,
             'stale_value_share_pct', v.stale_value_share_pct,
             'low_confidence_ev', v.low_confidence_ev,
             'opened_count', v.opened_count,
             'packnft_total', v.packnft_total,
             'opened_pct_of_minted', v.opened_pct_of_minted
           )
      into v_corrected_ev
    from public.v_allday_pack_info v
    where v.dist_id = p_dist_id
    limit 1;
  end if;

  with tw as (
    select nullif(sum(drop_weight), 0) as total_weight
    from public.pack_drop_pool
    where collection_id = p_collection_id and dist_id = p_dist_id
  )
  select coalesce(jsonb_agg(row_to_json(h)::jsonb order by h.fmv_usd desc), '[]'::jsonb)
    into v_hero
  from (
    select coalesce(e.external_id, e.id::text) as route_slug,
           e.player_name, e.set_name, e.tier::text as tier, e.thumbnail_url,
           (select w.moment_id from public.wallet_moments_cache w
              where w.collection_id = p_collection_id and w.edition_key = e.external_id
                and w.moment_id ~ '^[0-9]+$' limit 1) as rep_nft_id,
           fmv.fmv_usd::float8 as fmv_usd,
           (pdp.drop_weight / tw.total_weight)::float8 as hit_probability
    from public.pack_drop_pool pdp
    cross join tw
    join public.editions e on e.id = pdp.edition_id
    left join lateral (
      select fmv_usd from public.fmv_snapshots
      where edition_id = pdp.edition_id order by computed_at desc limit 1
    ) fmv on true
    where pdp.collection_id = p_collection_id and pdp.dist_id = p_dist_id
      and pdp.drop_weight > 0 and fmv.fmv_usd is not null and fmv.fmv_usd > 0
    order by fmv.fmv_usd desc
    limit 5
  ) h;

  select exists(
    select 1 from public.pack_drop_pool
    where collection_id = p_collection_id and dist_id = p_dist_id and drop_weight > 0
  ) into v_has_pool;

  return jsonb_build_object(
    'pack_row', v_pack_row,
    'dist_fallback', v_dist_fallback,
    'corrected_ev', v_corrected_ev,
    'hero_editions', coalesce(v_hero, '[]'::jsonb),
    'has_pool', coalesce(v_has_pool, false)
  );
end;
$$;

revoke all on function public.get_pack_detail_bundle(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_pack_detail_bundle(uuid, text, text) to service_role;
