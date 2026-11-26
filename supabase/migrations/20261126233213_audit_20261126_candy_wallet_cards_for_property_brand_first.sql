-- audit_20261126_candy_wallet_cards_for_property_brand_first
--
-- The Candy Binder's brand filter timed out on a large wallet: 93.9 s and 12.9M buffer hits for a 125k-card
-- wallet picking DC, so the API answered 500 after 30 s (found by rendered QA, 3:25 PM PT 11-26). The first
-- version ran the latest-price lookup for EVERY card the wallet holds and applied the brand afterwards.
--
-- Same signature, same row shape, same sorts, same json envelope. What changes is the ORDER of work:
--   1. the brand's editions first (ed),
--   2. only the wallet's cards in those editions, through the (wallet, edition_key) index (held),
--   3. the latest price ONCE PER DISTINCT EDITION held (lf) — 310 lookups for that wallet, not 16,856.
-- Measured on the same wallet + brand: 38,818 buffers for the three steps (was 12.9M).
-- Result equality was checked on two wallets x six sort/offset pairs (md5 of the json) before and after.
--
-- Revert: re-apply 20261126225745 (the previous body).

CREATE OR REPLACE FUNCTION public.get_candy_wallet_cards_for_property(
  p_wallet text, p_property text, p_sort_by text default 'fmv_desc', p_limit integer default 50,
  p_offset integer default 0, p_player text default null, p_tier text default null)
returns json
language sql stable
set search_path = pg_catalog, public
as $fn$
  with cid as (select '209ade70-32c5-4470-bc7c-4793d660f713'::uuid u),
  ed as materialized (
    select e.id, e.external_id, e.player_name, e.set_name, e.tier, e.series, e.circulation_count,
           e.team_name, e.thumbnail_url, e.name
    from public.candy_collections c
    join public.editions e on e.set_id = c.set_id and e.collection_id = (select u from cid)
    where c.property_slug = p_property
  ),
  held as materialized (
    select wmc.moment_id, wmc.edition_key, wmc.serial_number, wmc.player_name, wmc.set_name, wmc.tier,
           wmc.series_number, wmc.team_name, wmc.acquired_at, wmc.last_seen_at, wmc.is_locked, wmc.lock_checked_at
    from public.wallet_moments_cache wmc
    where wmc.wallet_address = p_wallet
      and wmc.collection_id = (select u from cid)
      and wmc.edition_key in (select ed.external_id from ed)
  ),
  lf as materialized (
    select d.id as edition_id, x.fmv_usd, x.confidence, x.floor_price_usd, x.algo_version, x.sales_count_30d
    from (select distinct ed.id from ed join held h on h.edition_key = ed.external_id) d
    left join lateral (
      select fs.fmv_usd, fs.confidence::text as confidence, fs.floor_price_usd, fs.algo_version, fs.sales_count_30d
      from public.fmv_snapshots fs
      where fs.edition_id = d.id and fs.computed_at <= now()
      order by fs.computed_at desc
      limit 1
    ) x on true
  ),
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
    from held wmc
    join ed e on e.external_id = wmc.edition_key
    left join lf on lf.edition_id = e.id
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
-- anon-exec: unchanged (get_candy_wallet_cards_for_property) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon=false, read with has_function_privilege before this file).
