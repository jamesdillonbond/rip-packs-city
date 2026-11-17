-- Snapshot migration: public.compute_pinnacle_serial_fmv_multipliers(integer, integer, numeric).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- The Pinnacle serial-FMV band multipliers (the Pinnacle sibling of the pinned
-- TS compute_serial_fmv_multipliers). It buckets sales into serial bands
-- (first / low5 / low20 / normal) by serial-vs-mint position, takes each band's
-- MEDIAN sale-price-to-render-median ratio, and NORMALIZES every band against the
-- 'normal' band so 'normal' = 1.0. The multiplier is FLOORED at 1.0 (a scarce
-- serial is never valued below a normal one) and CAPPED at p_cap (a thin-sample
-- outlier can't 40x a serial). is_reliable gates on sample size. A regression
-- mis-values every serial-keyed Pinnacle FMV, which feeds wallet/trophy pricing.
--
-- Pinned by supabase/tests/compute_pinnacle_serial_fmv_multipliers.sql.

CREATE OR REPLACE FUNCTION public.compute_pinnacle_serial_fmv_multipliers(p_lookback_days integer DEFAULT 365, p_min_sample integer DEFAULT 30, p_cap numeric DEFAULT 40.0)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
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
$function$;
