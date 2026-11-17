-- P4 (2026-07-06): render-keyed Pinnacle serial-premium model. Measured signal is
-- strong + clean (365d, 18,340 serial'd sales, 317 fittable renders): a global
-- serial-position-band curve normalized to the normal band = 1.0 —
--   #1 ~15x · top-5% ~2.2x · 5-20% ~1.2x · normal 1.0 (relative to render median).
-- Kept SEPARATE from the flat render FMV (pinnacle_catalog.fmv_usd) for clean revert:
-- an OVERLAY applied on demand via pinnacle_serial_fmv_estimate, never written back
-- into the render FMV. Revert: DROP the fit fn + the table.
create table if not exists public.pinnacle_serial_fmv_multipliers (
  band         text primary key,
  sample_size  integer not null,
  multiplier   numeric not null,
  is_reliable  boolean not null default false,
  computed_at  timestamptz not null default now()
);
alter table public.pinnacle_serial_fmv_multipliers enable row level security;
revoke all on table public.pinnacle_serial_fmv_multipliers from anon, authenticated;
grant select on table public.pinnacle_serial_fmv_multipliers to service_role;

create or replace function public.compute_pinnacle_serial_fmv_multipliers(
  p_lookback_days integer default 365,
  p_min_sample integer default 30,
  p_cap numeric default 40.0
)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  v_normal numeric;
  v_written integer;
begin
  create temporary table _psf_bands on commit drop as
  with rmed as (
    select render_id, percentile_cont(0.5) within group (order by sale_price_usd) as render_med
    from public.pinnacle_sales
    where sold_at > now() - make_interval(days => p_lookback_days)
      and serial_number is not null and serial_number > 0 and sale_price_usd > 0
    group by render_id
  ),
  base as (
    select ps.serial_number, ps.sale_price_usd, pc.total_minted, rm.render_med
    from public.pinnacle_sales ps
    join public.pinnacle_catalog pc on pc.render_id = ps.render_id
    join rmed rm on rm.render_id = ps.render_id
    where ps.sold_at > now() - make_interval(days => p_lookback_days)
      and ps.serial_number is not null and ps.serial_number > 0 and ps.sale_price_usd > 0
      and pc.total_minted is not null and pc.total_minted > 1 and rm.render_med > 0
  ),
  banded as (
    select case
             when serial_number = 1 then 'first'
             when serial_number::numeric / total_minted <= 0.05 then 'low5'
             when serial_number::numeric / total_minted <= 0.20 then 'low20'
             else 'normal'
           end as band,
           sale_price_usd / render_med as ratio
    from base
  )
  select band, count(*)::int as sample_size,
         percentile_cont(0.5) within group (order by ratio) as median_ratio
  from banded group by band;

  select median_ratio into v_normal from _psf_bands where band = 'normal';
  if v_normal is null or v_normal <= 0 then v_normal := 1.0; end if;

  delete from public.pinnacle_serial_fmv_multipliers;
  insert into public.pinnacle_serial_fmv_multipliers (band, sample_size, multiplier, is_reliable, computed_at)
  select band, sample_size,
         least(greatest(median_ratio / v_normal, 1.0), p_cap) as multiplier,
         sample_size >= p_min_sample as is_reliable,
         now()
  from _psf_bands;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

revoke all on function public.compute_pinnacle_serial_fmv_multipliers(integer, integer, numeric) from public, anon, authenticated;
grant execute on function public.compute_pinnacle_serial_fmv_multipliers(integer, integer, numeric) to service_role;

-- Overlay applied to a render's flat FMV for a given serial. Returns base_fmv
-- unchanged when the band has no reliable multiplier or inputs are missing.
create or replace function public.pinnacle_serial_fmv_estimate(
  p_serial integer,
  p_mint_count integer,
  p_base_fmv numeric
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with band as (
    select case
             when p_serial is null or p_serial <= 0 or p_base_fmv is null then null
             when p_serial = 1 then 'first'
             when p_mint_count is null or p_mint_count <= 1 then 'normal'
             when p_serial::numeric / p_mint_count <= 0.05 then 'low5'
             when p_serial::numeric / p_mint_count <= 0.20 then 'low20'
             else 'normal'
           end as b
  )
  select case
           when band.b is null then p_base_fmv
           else round(p_base_fmv * coalesce(
             (select m.multiplier from public.pinnacle_serial_fmv_multipliers m
               where m.band = band.b and m.is_reliable), 1.0), 2)
         end
  from band;
$$;

revoke all on function public.pinnacle_serial_fmv_estimate(integer, integer, numeric) from public, anon;
grant execute on function public.pinnacle_serial_fmv_estimate(integer, integer, numeric) to service_role, authenticated;

-- Seed the fit + weekly refresh (Sun 12:00 UTC, staggered from TS serial-fmv jobs).
select public.compute_pinnacle_serial_fmv_multipliers();
select cron.schedule('rpc-pinnacle-serial-fmv-multipliers-weekly', '0 12 * * 0',
  $$select public.compute_pinnacle_serial_fmv_multipliers();$$);

-- Revert:
--   select cron.unschedule('rpc-pinnacle-serial-fmv-multipliers-weekly');
--   drop function public.pinnacle_serial_fmv_estimate(integer, integer, numeric);
--   drop function public.compute_pinnacle_serial_fmv_multipliers(integer, integer, numeric);
--   drop table public.pinnacle_serial_fmv_multipliers;
