-- audit_20260927_pinnacle_serial_premium_first_and_perfect_only
--
-- WHY (Trevor, 2026-09-27): "Serial est feels like it should be part of our
-- typical FMV pattern, which really only should apply serial premiums for #1
-- and Perfect Serials." The shared estimator (serial_fmv_estimate) prices only
-- #1 and PERFECT (#N of N; plus jersey-match, a sports-only concept). Pinnacle's
-- own overlay priced four bands instead — #1, top 5% (x2.45), top 20% (x1.23),
-- normal — and had NO perfect band. Now: first / perfect / normal only.
--
-- Measured 2026-09-27 over the 365-day fit window (render-median ratios):
--   first   n=50  median x14.45   (p25 9.71 · p75 27.08)
--   perfect n=36  median x3.49    (p25 1.45 · p75 5.29)   — clears p_min_sample 30
--   other   n=11,949 median x1.00
--
-- Both bodies are the LIVE bodies (prosrc md5 verified equal to the pins before
-- this edit: estimate 693b2ac6…, compute 65dd55a2…) with only the band CASE
-- changed. The table is refit at the end of this migration so no reader sees
-- low5/low20 rows or a missing perfect band until next Sunday's run.
--
-- anon-exec: unchanged (pinnacle_serial_fmv_estimate) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false, authenticated=false.
-- anon-exec: unchanged (compute_pinnacle_serial_fmv_multipliers) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false, authenticated=false.
--
-- Revert: re-apply the two bodies in
--   20260725004336_audit_20260725_pin_pinnacle_serial_fmv_estimate.sql and
--   20260802203000_audit_20260802_snapshot_compute_pinnacle_serial_fmv_multipliers.sql,
-- then `SELECT public.compute_pinnacle_serial_fmv_multipliers();`

CREATE OR REPLACE FUNCTION public.pinnacle_serial_fmv_estimate(p_serial integer, p_mint_count integer, p_base_fmv numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with band as (
    select case
             when p_serial is null or p_serial <= 0 or p_base_fmv is null then null
             when p_serial = 1 then 'first'
             when p_mint_count is not null and p_mint_count > 1 and p_serial = p_mint_count then 'perfect'
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
$function$;

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
             when serial_number = total_minted then 'perfect'
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

SELECT public.compute_pinnacle_serial_fmv_multipliers();
