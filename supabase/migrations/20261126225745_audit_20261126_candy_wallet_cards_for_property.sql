-- audit_20261126_candy_wallet_cards_for_property
--
-- The Candy Binder's league / brand filter (?property=<slug> on /api/collection-moments). The Binder's paged
-- read is get_wallet_moments_with_fmv — one pinned function shared by every collection — and it is NOT
-- changed here. This is its Candy arm (the `base_other` leg, Candy's collection_id fixed) with one more
-- predicate: the card's collection belongs to the brand. Same sorts, same row shape, same json envelope
-- ({ moments, total_count }), so the Binder maps its rows unchanged.
--
-- ⚠ A COPY: when get_wallet_moments_with_fmv's row shape changes, change this too (the Binder reads both).
-- An unknown slug returns no rows; the API refuses an unknown slug before calling this.
--
-- Revert: remove the caller (app/api/collection-moments/route.ts, the `property` branch), then the function.

CREATE OR REPLACE FUNCTION public.get_candy_wallet_cards_for_property(
  p_wallet text, p_property text, p_sort_by text default 'fmv_desc', p_limit integer default 50,
  p_offset integer default 0, p_player text default null, p_tier text default null)
returns json
language sql stable
set search_path = pg_catalog, public
as $fn$
  with cid as (select '209ade70-32c5-4470-bc7c-4793d660f713'::uuid u),
  base as (
    select
      wmc.moment_id, wmc.edition_key, null::text as render_id, wmc.serial_number,
      coalesce(wmc.player_name, e.player_name,
        case when position(' — ' in coalesce(e.name, '')) > 0 then trim(split_part(e.name, ' — ', 1)) else e.name end) as player_name,
      coalesce(wmc.set_name, e.set_name,
        case when position(' — ' in coalesce(e.name, '')) > 0 then trim(split_part(e.name, ' — ', 2)) else null end) as set_name,
      coalesce(wmc.tier, e.tier::text) as tier,
      coalesce(wmc.series_number, e.series) as series_number,
      e.circulation_count,
      coalesce(wmc.team_name, e.team_name) as team_name,
      e.thumbnail_url,
      e.name as edition_name,
      lf.fmv_usd, lf.confidence, lf.floor_price_usd as low_ask, lf.algo_version as fmv_method,
      wmc.acquired_at as acquired_at_raw, wmc.last_seen_at,
      wmc.is_locked as is_locked, (wmc.lock_checked_at is not null) as lock_known,
      e.id as edition_id, lf.sales_count_30d
    from public.wallet_moments_cache wmc
    join public.editions e on e.external_id = wmc.edition_key and e.collection_id = (select u from cid)
    join public.candy_collections c on c.set_id = e.set_id and c.property_slug = p_property
    left join lateral (
      select fs.fmv_usd, fs.confidence::text as confidence, fs.floor_price_usd, fs.algo_version, fs.sales_count_30d
      from public.fmv_snapshots fs
      where fs.edition_id = e.id and fs.computed_at <= now()
      order by fs.computed_at desc
      limit 1
    ) lf on true
    where wmc.wallet_address = p_wallet
      and wmc.collection_id = (select u from cid)
  ),
  filtered as (
    select * from base
    where (p_player is null or public._norm_player(player_name) like '%' || public._norm_player(p_player) || '%')
      and (p_tier is null or lower(tier) = lower(p_tier))
  ),
  total as (select count(*) as cnt from filtered),
  acq as (
    select distinct on (ma3.nft_id) ma3.nft_id, ma3.acquired_date, ma3.buy_price
    from public.moment_acquisitions ma3
    where p_sort_by in ('recent', 'recent_asc', 'paid_desc', 'paid_asc')
      and ma3.wallet = p_wallet
      and ma3.collection_id = (select u from cid)
    order by ma3.nft_id, ma3.created_at desc
  ),
  paged as (
    select f.*
    from filtered f
    left join acq on acq.nft_id = f.moment_id
    order by
      case when p_sort_by in ('fmv_desc', 'price_desc') then f.fmv_usd end desc nulls last,
      case when p_sort_by in ('fmv_asc', 'price_asc') then f.fmv_usd end asc nulls last,
      case when p_sort_by = 'serial_asc' then f.serial_number end asc nulls last,
      case when p_sort_by = 'recent' then coalesce(acq.acquired_date, f.acquired_at_raw) end desc nulls last,
      case when p_sort_by = 'recent_asc' then coalesce(acq.acquired_date, f.acquired_at_raw) end asc nulls last,
      case when p_sort_by = 'paid_desc' then acq.buy_price end desc nulls last,
      case when p_sort_by = 'paid_asc' then acq.buy_price end asc nulls last,
      case when p_sort_by not in ('fmv_desc','price_desc','fmv_asc','price_asc','serial_asc','recent','recent_asc','paid_desc','paid_asc') then f.fmv_usd end desc nulls last,
      f.moment_id
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)
  ),
  enriched as (
    select
      p.moment_id, p.edition_key, p.render_id, p.serial_number, p.player_name, p.set_name, p.tier,
      p.series_number, p.circulation_count, p.team_name, p.thumbnail_url, p.edition_name,
      p.fmv_usd, p.confidence, p.low_ask, p.fmv_method,
      coalesce(ma.acquired_date, p.acquired_at_raw) as acquired_at,
      p.last_seen_at,
      ma.buy_price, ma.acquisition_method, ma.acquisition_confidence, ma.source as acquisition_source,
      ma.source_address, ma.loan_principal,
      p.is_locked, p.lock_known, p.edition_id, p.sales_count_30d,
      public.serial_fmv_estimate((select u from cid), p.serial_number, p.circulation_count, p.tier, p.fmv_usd, p.confidence, p.edition_id) as serial_fmv,
      null::jsonb as price_band_30d
    from paged p
    left join lateral (
      select ma2.buy_price, ma2.acquisition_method, ma2.acquisition_confidence,
             ma2.source, ma2.source_address, ma2.acquired_date, ma2.loan_principal
      from public.moment_acquisitions ma2
      where ma2.nft_id = p.moment_id and ma2.wallet = p_wallet
        and ma2.collection_id = (select u from cid)
      order by ma2.created_at desc
      limit 1
    ) ma on true
  )
  select json_build_object(
    'moments', coalesce((select json_agg(row_to_json(enriched)) from enriched), '[]'::json),
    'total_count', (select cnt from total))
$fn$;
-- anon-exec: revoked (get_candy_wallet_cards_for_property) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.get_candy_wallet_cards_for_property(text, text, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.get_candy_wallet_cards_for_property(text, text, text, integer, integer, text, text) to postgres, service_role;
